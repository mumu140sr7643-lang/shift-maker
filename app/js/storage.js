// ブラウザの中への保存。保存の名前は、すべて頭に「shift-maker:」を付ける
// （同じアカウントの GitHub Pages は、ほかのアプリと保存場所が同じため）。
import { migrate, validateData } from './model.js?v=1.1';

export const PREFIX = 'shift-maker:';
export const KEYS = {
  data: PREFIX + 'data',
  prev: PREFIX + 'data-prev',
  savedAt: PREFIX + 'saved-at',
  prevAt: PREFIX + 'prev-at',
  backup: PREFIX + 'backup',
  broken: PREFIX + 'broken',
  theme: PREFIX + 'theme',
  step: PREFIX + 'step',
};

export const BACKUP_REASONS = {
  reset: 'リセットの前',
  month: '月を片付ける前',
  import: '取り込む前',
};

function get(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// 書けたら true。書けなかったら false（容量がいっぱい・保存が止められている など）
function set(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 消せなくても困らない */
  }
}

// 文字からデータを読む。読めなければ { error }
export function parseData(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { error: ['ファイルの中身が、このアプリのデータの形（JSON）ではありません。'] };
  }
  try {
    obj = migrate(obj);
  } catch (e) {
    return { error: [e.message] };
  }
  const errors = validateData(obj);
  if (errors.length) return { error: errors };
  return { data: obj };
}

// 起動したときに読む。
// status: 'ok' | 'empty' | 'broken'（読めなかった。中身は KEYS.broken に控えた）
export function loadData() {
  const raw = get(KEYS.data);
  if (raw === null) return { status: 'empty' };
  const r = parseData(raw);
  if (r.data) return { status: 'ok', data: r.data, savedAt: get(KEYS.savedAt) };
  set(KEYS.broken, JSON.stringify({ at: new Date().toISOString(), raw }));
  return { status: 'broken', errors: r.error };
}

export function brokenCopy() {
  const raw = get(KEYS.broken);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 保存する。いまの保存は「ひとつ前の保存」へ回す。
export function saveData(data) {
  const text = JSON.stringify(data);
  const old = get(KEYS.data);
  const oldAt = get(KEYS.savedAt);
  if (old !== null && old !== text) {
    if (!set(KEYS.prev, old)) return { ok: false };
    set(KEYS.prevAt, oldAt ?? '');
  }
  const at = new Date().toISOString();
  if (!set(KEYS.data, text)) return { ok: false };
  set(KEYS.savedAt, at);
  return { ok: true, at };
}

// リセット：いまの保存を「ひとつ前の保存」へ回してから消す（控えは先に saveBackup で残すこと）
export function clearData() {
  const old = get(KEYS.data);
  if (old !== null) {
    set(KEYS.prev, old);
    set(KEYS.prevAt, get(KEYS.savedAt) ?? '');
  }
  remove(KEYS.data);
  remove(KEYS.savedAt);
}

export function prevSave() {
  const raw = get(KEYS.prev);
  if (raw === null) return null;
  const r = parseData(raw);
  return r.data ? { data: r.data, at: get(KEYS.prevAt) || null } : null;
}

// 消す・置きかえる操作の前の控え。あとの自動保存では上書きされない。いちばん新しい1つだけ残す。
export function saveBackup(reason, data) {
  return set(KEYS.backup, JSON.stringify({ reason, at: new Date().toISOString(), data }));
}

export function loadBackup() {
  const raw = get(KEYS.backup);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    const r = parseData(JSON.stringify(b.data));
    if (!r.data) return null;
    return { reason: b.reason, at: b.at, data: r.data };
  } catch {
    return null;
  }
}

export function getPref(key) {
  return get(key);
}
export function setPref(key, value) {
  if (value === null) remove(key);
  else set(key, value);
}
