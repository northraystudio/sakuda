# 0002. picomatch の ReDoS の advisory（GHSA-fc5q-39xc-vjpf）を pnpm audit の例外にする

- Status: Accepted (2026-11-19)
- Issue: #92（対応）、#93（例外を外すための追跡）

## Context

CI の `pnpm audit --prod --audit-level=high` が main で失敗するようになった（high 2件）。2件とも同じ advisory で、依存の経路が2つある。

| advisory            | パッケージ        | 依存の経路                                                                 | 状況                                                    |
| ------------------- | ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| GHSA-fc5q-39xc-vjpf | `picomatch` 4.0.7 | nuxt > picomatch、nuxt > @nuxt/devtools > unstorage > anymatch > picomatch | 直った版なし（対象は `<= 4.0.7`、npm の最新版も 4.0.7） |

advisory は「1つの分岐を繰り返す extglob で ReDoS になる」というもの。2026-10-19 に公開され、2026-11-17 に更新された。取り下げられてはいない。

直った版が無いので、依存の更新でも `pnpm.overrides` での固定でも直らない。

`picomatch` は `nuxt` の dependencies から辿れるので `--prod` の対象になる。しかし使われるのはビルド時と開発時だけである（`@nuxt/kit` > `tinyglobby`、`unplugin`、`vite`、devtools のファイル監視）。2026-11-19 に次のことを確かめた。

- `pnpm build` の成果物で本番イメージにコピーされる `.output/server/node_modules`（30件）に、`picomatch`・`anymatch`・`unstorage`・`chokidar`・`tinyglobby`・`micromatch`・`unplugin`・`vite` のどれも入っていない。
- `.output/server` の `.mjs` / `.js` に、picomatch のコードが束ねられた跡（`picomatch`、`POSIX_REGEX_SOURCE`、`extglob`）が無い。
- `server/`・`app/`・`shared/`・`scripts/`・`nuxt.config.ts` に、`picomatch`・`micromatch`・`minimatch`・`anymatch` の import が無い。

ADR 0001（#12）と同じ形の状況である。

## Decision

- GHSA-fc5q-39xc-vjpf の1件だけを、`package.json` の `pnpm.auditConfig.ignoreGhsas` で **advisory ID 単位**の例外にする。
- パッケージ単位の例外、`--audit-level` の緩和、ジョブの無効化はしない。
- `pnpm.overrides` での版の固定と、nuxt などの依存の更新はしない。どちらも picomatch を 4.0.7 から動かせないため。
- moderate 以下の advisory には、この ADR では手を付けない（CI の基準の外）。

## Consequences

- CI の Node Dependency Audit は green に戻る。新しい high 以上の advisory は、picomatch の別の advisory も含めて、今まで通り CI を落とす。
- 例外にした分は、開発者の手元（`pnpm dev`、ビルド）にはリスクとして残る。本番イメージには届かない。攻撃者が glob のパターンを渡せる経路は開発時にも見当たらないが、詳しくは調べていない。
- 例外は放っておくと残り続けるので、#93 で追跡する。picomatch に直った版が出たら依存を更新して例外を外し、この ADR を Superseded にする。
- `nuxt` の更新で、picomatch が実行時の依存（`.output` に入るもの）に変わった場合、この判断の前提が崩れる。その時点で例外を見直す。
