# OR-Tools の CP-SAT で、build.js の段の式を段階的に解く（docs/OR-Tools の試し.md の 2 章）。測るためだけ。アプリには入れない。
# tools/cpsat.mjs が動かす。標準入力で JSON を1つ受け取り、標準出力に JSON を1つ返す。
#   受け取る：{"lp": "LP の文（式と 2択の変数）", "stages": [{"key", "name", "objective": {"c": 定数, "t": [[名前, 係数], ...]}}],
#             "time": 合計の秒, "workers": 本数, "seed": 種, "ub": 量の変数の上限}
#   返す：{"ok", "reason"?, "stages": [{"key", "name", "status", "seconds", "value", "code"}], "values": {名前: 値},
#         "seconds", "loadSeconds", "importSeconds", "ortools", "python", "peak", "vars", "cons", "scaled", "ubHits"}
# 段の進め方は app/js/solver/stages.js と同じ：
#   - 時間の配分（段1 は合計の 1/6、段2〜5 は合わせて 1/2、残りを最後の段）。合計には、式を読む・作る時間も入れる。
#   - 段が終わったら「その段の量 ≦ 見つけた値」を足す（整数にした式で、ぴったり）。前の段の答えはヒントとして渡す。
#   - 答えが無い・前の段の答えより悪いときは、前の段の答えのまま（kept）。段1 で答えが無ければ、作れない。
#   - status：'solved'（CP-SAT が「これ以上は無い」と言えた）| 'limit'（時間切れで途中の答え）| 'kept' | 'none'
# 整数にするやり方：
#   - 2択の変数は 0〜1 の整数。量の変数（LP では 0 以上の数）は 0〜ub の整数。
#   - 係数・右の数に小数がある式（例：半休 0.5 日を入れた有給の式）は、式を何倍かして整数にする。
#     その式に出てくる量の変数には、とれる値の細かさに合わせて「倍」を付ける（量 = 整数の変数 ÷ 倍。例：有給のずれは半日の数）。
#   - 段の式も、何倍かして整数にする（例：余り日の重み 0.5 は、式全体を2倍）。
import time

T_IMPORT = time.perf_counter()
import json
import platform
import sys
from fractions import Fraction
from math import gcd

import ortools
from ortools.sat.python import cp_model

IMPORT_SECONDS = time.perf_counter() - T_IMPORT
MAX_SCALE = 1000
BIG = 2 ** 62


def lcm(a, b):
    return a * b // gcd(a, b)


def peak_memory():
    if platform.system() != 'Windows':
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t),
                    ('WorkingSetSize', ctypes.c_size_t), ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
    pmc = PMC()
    pmc.cb = ctypes.sizeof(PMC)
    # 64ビットでは、ハンドルの形を決めておかないと読めない
    ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
    return pmc.PeakWorkingSetSize


def parse_terms(tokens):
    """['1', 'x', '+', '0.5', 'y', '-', '2', 'z'] → [(Fraction, 名前)]"""
    out = []
    sign = 1
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ('+', '-'):
            sign = 1 if t == '+' else -1
            i += 1
            continue
        try:
            coef = Fraction(t)
        except ValueError:  # 係数の無い項（例：fixzero: zero = 0）は係数 1
            out.append((Fraction(sign), t))
            sign = 1
            i += 1
            continue
        out.append((sign * coef, tokens[i + 1]))
        sign = 1
        i += 2
    return out


def budget_for(i, count, total, used):
    """stages.js の budgetFor と同じ"""
    left = max(1, total - used)
    if count == 1 or i == count - 1:
        return left
    if i == 0:
        return min(left, total / 6)
    mid = max(1, count - 2)
    return max(1, min(left - 1, total / 2 / mid))


class Model:
    def __init__(self, lp, ub):
        rows = []
        binaries = set()
        section = None
        for raw in lp.split('\n'):
            line = raw.strip()
            if not line:
                continue
            if line in ('Minimize', 'Subject To', 'Binary', 'End'):
                section = line
                continue
            if section == 'Subject To':
                _, body = line.split(':', 1)
                toks = body.split()
                op = next(t for t in toks if t in ('<=', '>=', '='))
                k = toks.index(op)
                rows.append((parse_terms(toks[:k]), op, Fraction(toks[k + 1])))
            elif section == 'Binary':
                binaries.update(line.split())
        names = []
        index = {}
        for terms, _, _ in rows:
            for _, v in terms:
                if v not in index:
                    index[v] = len(names)
                    names.append(v)
        self.names = names
        self.index = index
        self.binaries = binaries
        self.ub = int(ub)
        # 量の変数の倍：式ごとに、ほかの係数（量の変数は倍で割ったもの）と右の数の分母の最小公倍数 D と、その変数の係数 a から
        # 「a × D の分子」の最小公倍数をとる。ほかが整数（と倍の細かさ）のときに、その式が求める値をとれる細かさ。変わらなくなるまで繰り返す
        scale = {v: 1 for v in names if v not in binaries}
        changed = True
        while changed:
            changed = False
            for terms, _, rhs in rows:
                for a, v in terms:
                    if v in binaries:
                        continue
                    d = rhs.denominator
                    for b, u in terms:
                        if u != v:
                            d = lcm(d, (b / scale.get(u, 1)).denominator)
                    s = lcm(scale[v], (abs(a) * d).numerator)
                    if s != scale[v]:
                        if s > MAX_SCALE:
                            raise ValueError(f'倍が大きすぎる量の変数: {v}')
                        scale[v] = s
                        changed = True
        self.scale = scale
        # ortools 9.15 の式の入れ物（CpModel の proto）に、じかに書く
        self.base = cp_model.CpModel()
        proto = self.base.proto
        for v in names:
            var = proto.variables.add()
            var.name = v
            if v in binaries:
                var.domain.extend([0, 1])
            elif v == 'zero':
                var.domain.extend([0, 0])
            else:
                var.domain.extend([0, self.ub * scale[v]])
        for terms, op, rhs in rows:
            m, coefs, r = self.integer(terms, rhs)
            c = proto.constraints.add()
            c.linear.vars.extend([i for _, i in coefs])
            c.linear.coeffs.extend([a for a, _ in coefs])
            if op == '<=':
                c.linear.domain.extend([-BIG, r.numerator // r.denominator])
            elif op == '>=':
                c.linear.domain.extend([-((-r.numerator) // r.denominator), BIG])
            else:
                if r.denominator != 1:
                    raise ValueError('等式の右の数が整数にならない')
                c.linear.domain.extend([int(r), int(r)])
        self.proto = proto
        self.rows = len(rows)

    def integer(self, terms, rhs=Fraction(0)):
        """量の変数の倍を入れ、全体を何倍かして整数にする。返す：(倍, [(整数の係数, 番号)], 整数にした右の数)"""
        scaled = [(a / self.scale.get(v, 1), v) for a, v in terms]
        m = rhs.denominator
        for a, _ in scaled:
            m = lcm(m, a.denominator)
        return m, [(int(a * m), self.index[v]) for a, v in scaled if a != 0], rhs * m

    def stage_objective(self, obj):
        terms = []
        for v, a in obj['t']:
            if a == 0:
                continue
            if v not in self.index:
                raise ValueError(f'式に無い変数: {v}')
            terms.append((Fraction(a).limit_denominator(10 ** 6), v))
        m, coefs, _ = self.integer(terms)
        return m, coefs, Fraction(obj['c']).limit_denominator(10 ** 6)


def run(msg):
    t0 = time.perf_counter()
    model = Model(msg['lp'], msg['ub'])
    load = time.perf_counter() - t0
    total = float(msg['time'])
    workers = int(msg.get('workers', 8))
    seed = int(msg.get('seed', 1))
    stages = msg['stages']
    objs = [model.stage_objective(st['objective']) for st in stages]
    records = []
    bounds = []  # [(coefs, 上限の整数)]
    last = None  # いまの答え（整数にした変数の値の並び）

    def value_int(coefs, sol):
        return sum(a * sol[i] for a, i in coefs)

    base = {'importSeconds': round(IMPORT_SECONDS, 3), 'loadSeconds': round(load, 3), 'ortools': ortools.__version__, 'python': platform.python_version(),
            'vars': len(model.names), 'cons': model.rows, 'scaled': sum(1 for s in model.scale.values() if s != 1), 'workers': workers, 'seed': seed, 'time': total}
    for i, st in enumerate(stages):
        m, coefs, const = objs[i]
        cm = cp_model.CpModel()
        p = cm.proto
        p.copy_from(model.proto)
        for bc, bmax in bounds:
            c = p.constraints.add()
            c.linear.vars.extend([j for _, j in bc])
            c.linear.coeffs.extend([a for a, _ in bc])
            c.linear.domain.extend([-BIG, bmax])
        p.objective.vars.extend([j for _, j in coefs])
        p.objective.coeffs.extend([a for a, _ in coefs])
        if last is not None:
            p.solution_hint.vars.extend(range(len(model.names)))
            p.solution_hint.values.extend(last)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max(0.1, budget_for(i, len(stages), total, time.perf_counter() - t0))
        solver.parameters.num_workers = workers
        solver.parameters.random_seed = seed
        s0 = time.perf_counter()
        status = solver.Solve(cm)
        seconds = round(time.perf_counter() - s0, 2)
        code = solver.StatusName(status)
        sol = list(solver.ResponseProto().solution) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None
        before = value_int(coefs, last) if last is not None else None
        after = value_int(coefs, sol) if sol is not None else None
        rec = {'key': st['key'], 'name': st['name'], 'seconds': seconds, 'code': code}
        if after is not None and (before is None or after <= before):
            last = sol
            v = after
            rec['status'] = 'solved' if status == cp_model.OPTIMAL else 'limit'
        elif last is not None:
            v = before
            rec['status'] = 'kept'
            if status == cp_model.OPTIMAL:
                rec['suspect'] = True
        else:
            rec.update({'status': 'none', 'value': None})
            records.append(rec)
            return {**base, 'ok': False, 'reason': 'infeasible' if status == cp_model.INFEASIBLE else 'no-answer', 'stages': records,
                    'seconds': round(time.perf_counter() - t0, 2), 'peak': peak_memory()}
        rec['value'] = float(Fraction(v, m) + const)
        bounds.append((coefs, v))
        records.append(rec)
    values = {v: last[i] / model.scale.get(v, 1) for i, v in enumerate(model.names)}
    ub_hits = [v for i, v in enumerate(model.names) if v not in model.binaries and v != 'zero' and last[i] >= model.ub * model.scale[v]]
    return {**base, 'ok': True, 'stages': records, 'values': values, 'ubHits': ub_hits, 'seconds': round(time.perf_counter() - t0, 2), 'peak': peak_memory()}


if __name__ == '__main__':
    msg = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    try:
        out = run(msg)
    except Exception as e:  # 道具の中のまちがいは、node の側へ文で返す
        out = {'ok': False, 'reason': 'error', 'error': f'{type(e).__name__}: {e}'}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
