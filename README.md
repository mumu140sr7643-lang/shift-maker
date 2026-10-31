# シフト表メーカー

1か月分のシフト表を、ブラウザの中だけで作るアプリです。業種を問わず使えます。
入れたデータは、使う人のブラウザの中にだけ保存され、インターネットの向こうへは送りません。

いまは作っている途中です（版 1.3：見本・基本設定・シフトの種類・スタッフ・希望の入力・手で作るシフト表・保存と控え・書き出しと取り込み）。

- 試す：`app/` を開きます（作り物の見本データで試せます）
- 何を作るか：[docs/説明書.md](docs/説明書.md)
- 作るときの決まり：[CLAUDE.md](CLAUDE.md)

## 手元で動かす

```
python -m http.server 8765
```

を、このフォルダで動かし、ブラウザで `http://localhost:8765/app/` を開きます。

## 使っている部品

- [HiGHS](https://highs.dev)（数理最適化。自動で作るで使う）：MIT ライセンス。`vendor/highs/` に、npm の `highs` 版 1.15.4（https://github.com/lovasoa/highs-js ）を手を加えずに置いています（`vendor/highs/LICENSE`）。
- [ExcelJS](https://github.com/exceljs/exceljs)（Excel のファイルを作る。「Excel に出す」で使う）：MIT ライセンス。`vendor/exceljs/` に、npm の `exceljs` 版 4.4.0 の `dist/exceljs.bare.min.js` を手を加えずに置いています（`vendor/exceljs/LICENSE`）。
