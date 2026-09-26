# Changelog

## [0.7.1](https://github.com/stablekernel/pi-background-run/compare/v0.7.0...v0.7.1) (2026-09-26)


### Bug Fixes

* **bggrep:** accept a leading (?i) flag group and explain the others ([#24](https://github.com/stablekernel/pi-background-run/issues/24)) ([5f2fe09](https://github.com/stablekernel/pi-background-run/commit/5f2fe0929dee01a159c90dade8cf2de5f1ab024e))
* **bgrun:** discourage polling a job you just started ([#27](https://github.com/stablekernel/pi-background-run/issues/27)) ([c6680f2](https://github.com/stablekernel/pi-background-run/commit/c6680f295187250edd3e114b5bdd2efb9ed5246e))
* **bgtail:** a wider lines window returns the earlier lines, not "no new lines" ([#23](https://github.com/stablekernel/pi-background-run/issues/23)) ([d5e2360](https://github.com/stablekernel/pi-background-run/commit/d5e23607d2a7556762700a8862f1258e3716c5dc))

## [0.7.0](https://github.com/stablekernel/pi-background-run/compare/v0.6.0...v0.7.0) (2026-09-23)


### Features

* run on oh-my-pi, unify both hosts' background jobs, and add bgkill ([#19](https://github.com/stablekernel/pi-background-run/issues/19)) ([fbb15e6](https://github.com/stablekernel/pi-background-run/commit/fbb15e63c014dc81009aaa03486a9c297b0e1716))

## [0.6.0](https://github.com/stablekernel/pi-background-run/compare/v0.5.0...v0.6.0) (2026-09-20)


### Features

* **digest:** opt-in scorecards with type/match selectors, per-project nudge, and diagnostics ([dd5b3e6](https://github.com/stablekernel/pi-background-run/commit/dd5b3e6cc25a3fb0083c189c948b21fc8489d5ce))
* default job logs to the project-local jobs dir ([#10](https://github.com/stablekernel/pi-background-run/issues/10)) ([d462ed7](https://github.com/stablekernel/pi-background-run/commit/d462ed7ab293520ba0462e079049ca8a7f0c080e))
* background job log size ceiling, hardened by an adversarial pass ([ae62842](https://github.com/stablekernel/pi-background-run/commit/ae628423c958941b86694bdcc3fb6bb023684c0c))


### Bug Fixes

* **ci:** grant pull-requests: write in release caller for reused ci.yml ([#8](https://github.com/stablekernel/pi-background-run/issues/8)) ([fb97d3e](https://github.com/stablekernel/pi-background-run/commit/fb97d3e2141dfb4d8dc6e7da518777f84204c511))
