# 0001. 開発時・ビルド時だけの依存の advisory を pnpm audit の例外にする

- Status: Accepted (2026-10-10)
- Issue: #12（対応）、#13（例外を外すための追跡）

## Context

CI の `pnpm audit --prod --audit-level=high` が main で失敗するようになった（37件: 3 critical / 17 high）。どれも `nuxt` 配下の推移的依存で、2026-09-20 以降に advisory が公開された。

semver の範囲内で依存を更新すると（nuxt 4.5.2 → 4.6.1 ほか）31件が消える。残る6件は直った版がないか、上流がまだ取り込んでいない。

| advisory                                                      | パッケージ                      | 依存の経路                             | 状況                                         |
| ------------------------------------------------------------- | ------------------------------- | -------------------------------------- | -------------------------------------------- |
| GHSA-x6jw-m9v5-85vh, GHSA-g4wm-2vf7-vfgr, GHSA-858h-whjf-mvg5 | `simple-git` 3.36.0             | nuxt > @nuxt/devtools 3.4.2            | 修正は v4。devtools の対応は 4.0.0-beta のみ |
| GHSA-v5rq-49vh-5v5c                                           | `@simple-git/argv-parser` 1.1.1 | 同上                                   | 同上                                         |
| GHSA-86w9-cpqp-85rv                                           | `node-forge` 1.4.0              | nuxt > nitropack > listhen             | 直った版なし                                 |
| GHSA-vfj7-8cjw-p6xm                                           | `braces` 3.0.3                  | nuxt > nitropack > globby > micromatch | 直った版なし                                 |

どれも `nuxt` の dependencies に含まれるので `--prod` の対象になる。しかし実際に使われるのは開発時だけ（devtools、dev サーバーの https）か、ビルド時だけ（nitropack の glob）。`pnpm build` の成果物で本番イメージにコピーされる `.output/server/node_modules` には、この3パッケージのどれも入っていないことを確認した（入っているのは `devalue` 6.0.2 などの実行時の依存だけ）。

## Decision

- 依存を範囲内の最新版に更新し、取り込める修正版はすべて入れる。
- 残る6件だけを、`package.json` の `pnpm.auditConfig.ignoreGhsas` で **advisory ID 単位**の例外にする。パッケージ単位の例外、`--audit-level` の緩和、ジョブの無効化はしない。
- `simple-git` を `pnpm.overrides` で v4 に強制する案は採らない。devtools 3.x とメジャー版が食い違い、開発時の devtools を壊しうるのに対し、本番で得るものがないため。
- `@nuxt/test-utils` は `~4.2.0` に留める。4.3 で `registerEndpoint` が h3 v2 になり、h3 v1 の `readBody` を使う既存のテストと合わないため。devDependency なので audit には影響しない。

## Consequences

- CI の Node Dependency Audit は green に戻る。新しい high 以上の advisory は、今まで通り CI を落とす。
- 例外にした6件は、開発者の手元（`pnpm dev`、devtools）にはリスクとして残る。本番イメージには届かない。
- 例外は放っておくと残り続けるので、#13 で追跡する。上流に直った版が出たら依存を更新して例外を外し、全部外せたらこの ADR を Superseded にする。
- `nuxt` の更新で、これらのパッケージが実行時の依存（`.output` に入るもの）に変わった場合、この判断の前提が崩れる。その時点で例外を見直す。
