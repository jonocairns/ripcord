# Changelog

## [2.6.0](https://github.com/jonocairns/ripcord/compare/v2.5.9...v2.6.0) (2026-11-11)


### Features

* show when the app is reconnecting to the server ([#420](https://github.com/jonocairns/ripcord/issues/420)) ([8277fe4](https://github.com/jonocairns/ripcord/commit/8277fe434dc69be08d1ad6aa4c3700d309416923))


### Bug Fixes

* show the disconnect screen 45 seconds after the connection is lost ([#422](https://github.com/jonocairns/ripcord/issues/422)) ([b0abf7d](https://github.com/jonocairns/ripcord/commit/b0abf7dd786c0223d7acc6859fea55c5aec55b99))
* sync voice producers after the event subscriptions have started ([#423](https://github.com/jonocairns/ripcord/issues/423)) ([c93beb7](https://github.com/jonocairns/ripcord/commit/c93beb7d6016db65f1f7827d863c4240fc844ac9))

## [2.5.9](https://github.com/jonocairns/ripcord/compare/v2.5.8...v2.5.9) (2026-11-11)


### Bug Fixes

* **desktop:** authenticate the app audio stream between the capture helper and the app ([#389](https://github.com/jonocairns/ripcord/issues/389)) ([8e98f3a](https://github.com/jonocairns/ripcord/commit/8e98f3afa298b551d375744d8db1994a7feca4ab))
* show private channels to a new owner as soon as the secret token is used ([#416](https://github.com/jonocairns/ripcord/issues/416)) ([cb3b0b3](https://github.com/jonocairns/ripcord/commit/cb3b0b33650e1a55e4dd12c09cb9d4dc0a5f9354))

## [2.5.8](https://github.com/jonocairns/ripcord/compare/v2.5.7...v2.5.8) (2026-11-10)


### Bug Fixes

* evict voice seats only for the current session and in a fixed order after role changes ([#407](https://github.com/jonocairns/ripcord/issues/407)) ([8f3d5a8](https://github.com/jonocairns/ripcord/commit/8f3d5a85a824a83a381267909d592fda55e9f269))
* keep older history reachable when a catch-up reload ends up empty ([#414](https://github.com/jonocairns/ripcord/issues/414)) ([55bf105](https://github.com/jonocairns/ripcord/commit/55bf105267b4a76185d6aadf0ed5b40f3f98e0f2))
* keep sign-in when a saved server URL is upgraded to HTTPS ([#411](https://github.com/jonocairns/ripcord/issues/411)) ([a3dffe8](https://github.com/jonocairns/ripcord/commit/a3dffe86f44cb92634a30c10a0a5c75c8b3998d7))
* record secret token use in the activity log ([#412](https://github.com/jonocairns/ripcord/issues/412)) ([e0e0646](https://github.com/jonocairns/ripcord/commit/e0e064664715af3c090a2b2e0ef175b97cbbd923))
* send the unread count when a user gains access to a channel ([#413](https://github.com/jonocairns/ripcord/issues/413)) ([41ab2eb](https://github.com/jonocairns/ripcord/commit/41ab2eb6fc4026cd49e18c69ce7225946fca9768))
* show the disconnect screen when the final silent rejoin gives up ([#408](https://github.com/jonocairns/ripcord/issues/408)) ([e8d4c7a](https://github.com/jonocairns/ripcord/commit/e8d4c7aef3626cefc6de92133a45f6e10d563591))

## [2.5.7](https://github.com/jonocairns/ripcord/compare/v2.5.6...v2.5.7) (2026-11-10)


### Bug Fixes

* replay own voice state when subscriptions attach and re-land the permission policy ([#404](https://github.com/jonocairns/ripcord/issues/404)) ([b4bacf8](https://github.com/jonocairns/ripcord/commit/b4bacf88e4e73ba1919d9b7088717c1c88eb44f7))

## [2.5.6](https://github.com/jonocairns/ripcord/compare/v2.5.5...v2.5.6) (2026-11-10)


### Bug Fixes

* close replaced server connections so they cannot disturb the active session ([#401](https://github.com/jonocairns/ripcord/issues/401)) ([0d76090](https://github.com/jonocairns/ripcord/commit/0d760905d39acc21e199f9ea860f7e63a605fe62))
* load missed messages and clear the unread marker in the open channel after a reconnect ([#400](https://github.com/jonocairns/ripcord/issues/400)) ([35b7979](https://github.com/jonocairns/ripcord/commit/35b79794d7969db280fe34d2cd8250919a9e2daa))
* reject a password change that races a session revocation and make role edits atomic ([#397](https://github.com/jonocairns/ripcord/issues/397)) ([eec5d59](https://github.com/jonocairns/ripcord/commit/eec5d594f0111195cdce59396bf11494ce730c83))
* require channel access to reorder private channels or manage their permissions ([#398](https://github.com/jonocairns/ripcord/issues/398)) ([a5941ee](https://github.com/jonocairns/ripcord/commit/a5941ee1e411d84b1bbad7c3a18fb7dcb270ddf9))

## [2.5.5](https://github.com/jonocairns/ripcord/compare/v2.5.4...v2.5.5) (2026-11-10)


### Bug Fixes

* clean up after a plugin fails to load and keep plugins loaded when saving other settings ([#393](https://github.com/jonocairns/ripcord/issues/393)) ([7d79679](https://github.com/jonocairns/ripcord/commit/7d7967908215510175c72823c208a4c9f387770f))
* keep the edit open and show the reason when a message edit is rejected ([#384](https://github.com/jonocairns/ripcord/issues/384)) ([42477da](https://github.com/jonocairns/ripcord/commit/42477da4898a41466c9261aa92f7fe0b378516b3))
* make channel, role and ordering changes atomic ([#388](https://github.com/jonocairns/ripcord/issues/388)) ([0d47add](https://github.com/jonocairns/ripcord/commit/0d47addc2243269ed252a7f09ea462f017236b89))
* make password, two-factor and token refresh changes atomic ([#386](https://github.com/jonocairns/ripcord/issues/386)) ([421c810](https://github.com/jonocairns/ripcord/commit/421c8102401fc1ebbe01418b0195082fb73b4e4e))
* require channel access to delete channels and clean up when a category is deleted ([#391](https://github.com/jonocairns/ripcord/issues/391)) ([6e77ba2](https://github.com/jonocairns/ripcord/commit/6e77ba229f0e57dfed814af5bf8435cad0ad17f0))
* restore voice after the server is unreachable long enough to show the disconnect screen ([#390](https://github.com/jonocairns/ripcord/issues/390)) ([ba66402](https://github.com/jonocairns/ripcord/commit/ba664023d9c94798473c48df40c6b1eca73ffc2a))
* stop edits and reactions from marking channels unread ([#385](https://github.com/jonocairns/ripcord/issues/385)) ([0960dcb](https://github.com/jonocairns/ripcord/commit/0960dcba412c7fef224d16c18607ae7db2e9347d))
* stop sending private voice channel activity to users who cannot view the channel ([#392](https://github.com/jonocairns/ripcord/issues/392)) ([635e3e5](https://github.com/jonocairns/ripcord/commit/635e3e5f933e7257a1a1c9531a8f42dc84bd7fe9))
* stop sending server stack traces to clients and rewriting read state on history pages ([#387](https://github.com/jonocairns/ripcord/issues/387)) ([4a97b12](https://github.com/jonocairns/ripcord/commit/4a97b1283043a475c35ba5e7b79315c8a1afdd36))

## [2.5.4](https://github.com/jonocairns/ripcord/compare/v2.5.3...v2.5.4) (2026-11-10)


### Bug Fixes

* **ci:** stop manual Claude review runs from executing fork code ([#376](https://github.com/jonocairns/ripcord/issues/376)) ([9ee89bf](https://github.com/jonocairns/ripcord/commit/9ee89bfe9c0814c5070d0106d72e16faa45e36d1))
* keep each server's sign-in tokens separate in the desktop app ([#380](https://github.com/jonocairns/ripcord/issues/380)) ([734fa9f](https://github.com/jonocairns/ripcord/commit/734fa9f5e8db4a71689cad434a1f657bb7b5781d))
* limit message length, reaction size, link previews and socket frames ([#381](https://github.com/jonocairns/ripcord/issues/381)) ([1f3cb24](https://github.com/jonocairns/ripcord/commit/1f3cb2482d59a0a02c9756618124d33411df3e40))
* rate limit password checks and uploads and hide ban reasons until sign-in ([#379](https://github.com/jonocairns/ripcord/issues/379)) ([2598f25](https://github.com/jonocairns/ripcord/commit/2598f25f3d52832397e447f87acc7bb2f27139ee))
* stop moderators reading private channels and fix storage overflow cleanup ([#378](https://github.com/jonocairns/ripcord/issues/378)) ([da6762f](https://github.com/jonocairns/ripcord/commit/da6762fdd036253d343ece88814e90d2fca4eea9))
* stop skipping a message at every history page boundary ([#375](https://github.com/jonocairns/ripcord/issues/375)) ([3c1b5f5](https://github.com/jonocairns/ripcord/commit/3c1b5f51035369fc40f8bd49ed34e30231180d39))
* stop the seeded owner account from using a known password ([#382](https://github.com/jonocairns/ripcord/issues/382)) ([1c189e5](https://github.com/jonocairns/ripcord/commit/1c189e5a99ac610660f74ac049d304f8e86536b8))
* strip classes and unsafe link attributes from message HTML ([#377](https://github.com/jonocairns/ripcord/issues/377)) ([842bdfb](https://github.com/jonocairns/ripcord/commit/842bdfb1a2d6f87b83d58edd7ef158a7ed36d31f))

## [2.5.3](https://github.com/jonocairns/ripcord/compare/v2.5.2...v2.5.3) (2026-10-24)


### Bug Fixes

* **desktop:** upgrade Electron to 42.11.18 for security fixes ([#373](https://github.com/jonocairns/ripcord/issues/373)) ([a74c711](https://github.com/jonocairns/ripcord/commit/a74c711e66e6cced38b71d8026db2656aa9f9a62))
* keep live audio consumers during existing producer sync ([#368](https://github.com/jonocairns/ripcord/issues/368)) ([c4a8296](https://github.com/jonocairns/ripcord/commit/c4a829619b7861bc418a34a33f9d5a8e64215410))
* pin link preview fetches and update vulnerable server deps ([#372](https://github.com/jonocairns/ripcord/issues/372)) ([70a1ed0](https://github.com/jonocairns/ripcord/commit/70a1ed08bb61f08c954933a74109dfac024a67c2))
* stop moderators from escalating to owner or past their own permissions ([#371](https://github.com/jonocairns/ripcord/issues/371)) ([4d6ca2f](https://github.com/jonocairns/ripcord/commit/4d6ca2f6ed25a4d95c60344ad57dd8eed1a2d551))
* upgrade Bun to 1.4.4 for Brotli RCE CVE-2026-111497 ([#370](https://github.com/jonocairns/ripcord/issues/370)) ([c8c7cb9](https://github.com/jonocairns/ripcord/commit/c8c7cb9d82ba8b92666be3224d955b7ed8dfdcc3))

## [2.5.2](https://github.com/jonocairns/ripcord/compare/v2.5.1...v2.5.2) (2026-10-14)


### Bug Fixes

* **desktop:** fail builds that externalize workspace packages ([#364](https://github.com/jonocairns/ripcord/issues/364)) ([3953031](https://github.com/jonocairns/ripcord/commit/3953031313ba97a5e6b1477ecced024c04e2f609))
* keep config.ini settings when new keys are added ([#363](https://github.com/jonocairns/ripcord/issues/363)) ([64cd41c](https://github.com/jonocairns/ripcord/commit/64cd41c32e3f78527c0af6b6bd1cbdc1a65dd397))
* log server presence with user IDs and report fatal errors ([#367](https://github.com/jonocairns/ripcord/issues/367)) ([d661dff](https://github.com/jonocairns/ripcord/commit/d661dff83aca08488b8fb31afb2bd853eec2e9ac))
* stop tracing voice activity updates ([#366](https://github.com/jonocairns/ripcord/issues/366)) ([e4a41c4](https://github.com/jonocairns/ripcord/commit/e4a41c4fd58534959ec7c95cb9c87689a2c6bea8))

## [2.5.1](https://github.com/jonocairns/ripcord/compare/v2.5.0...v2.5.1) (2026-10-13)


### Bug Fixes

* bundle shared package into desktop main process ([#361](https://github.com/jonocairns/ripcord/issues/361)) ([6fdd68a](https://github.com/jonocairns/ripcord/commit/6fdd68a517e8620a354353d2d52e816c81315f51))

## [2.5.0](https://github.com/jonocairns/ripcord/compare/v2.4.0...v2.5.0) (2026-10-13)


### Features

* add application tracing and voice diagnostics ([#354](https://github.com/jonocairns/ripcord/issues/354)) ([5d1633d](https://github.com/jonocairns/ripcord/commit/5d1633d49a17902dfd30bc7e4b8fa22b00ecd1c3))
* add local trace logging and richer voice diagnostics ([#360](https://github.com/jonocairns/ripcord/issues/360)) ([b85221b](https://github.com/jonocairns/ripcord/commit/b85221bce86f2a693b5d388958576c2b192b0909))
* add stream lifecycle and playback diagnostics ([#355](https://github.com/jonocairns/ripcord/issues/355)) ([2c0cfd3](https://github.com/jonocairns/ripcord/commit/2c0cfd3a9878a16f29657b9b8cdab74b015f8702))
* route client diagnostics and errors through the server ([#357](https://github.com/jonocairns/ripcord/issues/357)) ([c690815](https://github.com/jonocairns/ripcord/commit/c6908155e955c0430837813ac52eb4e8ce60e863))
* route provider-neutral traces through the server ([#358](https://github.com/jonocairns/ripcord/issues/358)) ([12cb23d](https://github.com/jonocairns/ripcord/commit/12cb23d65015041aae39c5c20dffdbf64fd02274))


### Bug Fixes

* keep browser diagnostics on the server by default ([#359](https://github.com/jonocairns/ripcord/issues/359)) ([ef7bcdb](https://github.com/jonocairns/ripcord/commit/ef7bcdb9968cc1e555bf6a5cd4cf7c478b1c7591))

## [2.4.0](https://github.com/jonocairns/ripcord/compare/v2.3.1...v2.4.0) (2026-10-09)


### Features

* add frameless media pop-outs with hover controls ([#352](https://github.com/jonocairns/ripcord/issues/352)) ([8718ad7](https://github.com/jonocairns/ripcord/commit/8718ad71b383af6beddc758cfefa522a6ebb27e2))

## [2.3.1](https://github.com/jonocairns/ripcord/compare/v2.3.0...v2.3.1) (2026-10-07)


### Bug Fixes

* fence video capture lifecycle completions ([#334](https://github.com/jonocairns/ripcord/issues/334)) ([9ad30b3](https://github.com/jonocairns/ripcord/commit/9ad30b3f9d3b1ad9b89d9a40ed891cee61fc4713))
* keep channel attachments out of shared caches ([#318](https://github.com/jonocairns/ripcord/issues/318)) ([e13070e](https://github.com/jonocairns/ripcord/commit/e13070ef0e6f141561043757e5941fb2a9fd1a4c))
* preserve share audio ownership through recovery and teardown ([#329](https://github.com/jonocairns/ripcord/issues/329)) ([d5de9c3](https://github.com/jonocairns/ripcord/commit/d5de9c34a6115220da6f44044a875d5fd8bf8af5))
* release fallback audio after failed recovery ([a8c4b91](https://github.com/jonocairns/ripcord/commit/a8c4b91987675d7c20b6b72324ebe00f791f567b))
* remove voice membership when leaving during recovery ([#351](https://github.com/jonocairns/ripcord/issues/351)) ([5c39d20](https://github.com/jonocairns/ripcord/commit/5c39d209a2f6ac368528d43cde3f82210f8d3245))
* sign every attachment and refresh links across channels ([#319](https://github.com/jonocairns/ripcord/issues/319)) ([a720cef](https://github.com/jonocairns/ripcord/commit/a720cefd3288215a77b5c576a6252f847e559d72))
* stop plugin commands from posting unescaped message HTML ([#316](https://github.com/jonocairns/ripcord/issues/316)) ([476b648](https://github.com/jonocairns/ripcord/commit/476b64841e98d6b697536be76c18c575d1ce2c8b))

## [2.3.0](https://github.com/jonocairns/ripcord/compare/v2.2.0...v2.3.0) (2026-09-28)


### Features

* remember desktop window size ([#314](https://github.com/jonocairns/ripcord/issues/314)) ([9563b27](https://github.com/jonocairns/ripcord/commit/9563b27763b6f38f5cec49af8cbc691898e09994))


### Bug Fixes

* align text composer with sidebar control ([#315](https://github.com/jonocairns/ripcord/issues/315)) ([0021615](https://github.com/jonocairns/ripcord/commit/0021615a45aa4f05bb69197364b6750da0edee23))
* enforce release-compatible PR titles ([#313](https://github.com/jonocairns/ripcord/issues/313)) ([d35ace9](https://github.com/jonocairns/ripcord/commit/d35ace9758ef81314eb9ede082794a7b33e47e6b))
* prevent Claude review cache poisoning ([d6c555d](https://github.com/jonocairns/ripcord/commit/d6c555def3d768ed2560f63b3f5dbe77e0f3b73b))
* skip desktop toolchains in server releases ([#310](https://github.com/jonocairns/ripcord/issues/310)) ([edf60dc](https://github.com/jonocairns/ripcord/commit/edf60dc86785b655c62d82d769a9cb42823a262f))

## [2.2.0](https://github.com/jonocairns/ripcord/compare/v2.1.53...v2.2.0) (2026-09-27)


### Features

* automate releases with Release Please ([#308](https://github.com/jonocairns/ripcord/issues/308)) ([3d42f9b](https://github.com/jonocairns/ripcord/commit/3d42f9b50a275a30dea1c2606eb88eb970617b5b))
