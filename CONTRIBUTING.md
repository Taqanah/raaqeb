<div dir="rtl">

# المساهمة في راقب

طلبات السحب مرحّب بها. تبدأ المساهمة عادةً بمشكلة، وقواعد السلوك في [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## قبل أن تكتب شيئًا

- افتح مشكلة تصف ما تريد تغييره ولماذا، أو اطرح الفكرة في Discussions. الاتفاق على الفكرة قبل الشفرة يوفّر عليك الوقت.
- الثغرة الأمنية لا تُفتح لها مشكلة. اتبع [SECURITY.md](SECURITY.md).

## طلب السحب

- يطلب منك بوت اتفاقية ترخيص المساهم (CLA) الموافقة عليها مرة واحدة عند أول طلب سحب لك، ولا يُدمج الطلب قبلها. تبقى لك ملكية مساهمتك، وتمنح راقب ترخيصًا بها.
- شغّل `bun run gate` قبل أن تفتح الطلب، ويجب أن ينجح.
- طلب واحد لميزة كاملة أو لإصلاح واحد، وعنوان كل إيداع بصيغة [Conventional Commits](https://www.conventionalcommits.org/).

## كيف تُكتب الشفرة هنا

اقرأ [AGENTS.md](AGENTS.md): البنية، والقواعد بين الوحدات، وحلقة الاختبار أولًا.

</div>

---

# Contributing to Raaqeb

Pull requests are welcome. A contribution usually starts with an issue, and the rules for how we treat each other are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before you write anything

- Open an issue that says what you want to change and why, or raise the idea in Discussions. Agreeing on the idea before the code saves you time.
- A security vulnerability never gets an issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

- A bot asks you to agree to the contributor license agreement (CLA) once, on your first pull request, and the request is not merged before you do. You keep the ownership of your contribution and give Raaqeb a license to it.
- Run `bun run gate` before you open the request. It must pass.
- One request is one whole feature or one fix, and each commit subject follows [Conventional Commits](https://www.conventionalcommits.org/).

## How code is written here

Read [AGENTS.md](AGENTS.md): the layout, the rules between modules and the test-first loop.

## Setup and commands / الإعداد والأوامر

```sh
bun install            # then bun run docs:pull to refresh the docs mirror
bun run dev            # Vite dev server on port 3000
bun run build          # dist/client, dist/server (the entry and the handler) and dist/migrations
bun run start          # raaqeb serve over the build; onboarding runs here, not under vite dev; boot settings in website/content/docs/operate/boot-settings.en.mdx
bun run binaries       # the Linux, macOS and Windows binaries and their SHA256SUMS in dist/bin
bun run image          # the amd64 and arm64 image as an OCI archive in dist/image, the host's loaded as ghcr.io/taqanah/raaqeb:<version>
bun run image:check    # the image on an empty volume, walked through onboarding; needs Docker
bun run upgrade:check <from-image> [<to-image>]  # an install with data from one image to the next, on SQLite and Postgres; needs Docker
bun run install:check  # the installer on Debian with systemd and Alpine with OpenRC, in containers; needs Docker
bun run catalog        # after editing locales/*/messages.po: lint, regenerate the id union, compile
bun run bench:record <run.json> <release>  # appends a release run's row to bench/floor/history.jsonl
bun run gate           # catalog check, lint, types, unit and integration tests on SQLite
docker compose up -d   # the test Postgres and Mailpit
bun run test:postgres  # the same tests against them; fails when either is down
bun run e2e:install    # once: the Chromium build Playwright pins
bun run e2e            # Playwright specs against the built entry
bun run dev            # then open /design: the sample page of the design language (development only)
bun run design:shots   # screenshots of that page
bun run bench          # the floor benchmark of a release, about 16 minutes, on the image bun run image loaded; Linux, cgroup v2 and Docker; results and an HTML report in bench/floor/results/
bun run bench --wiring # the same at wiring length, a few minutes; never quoted
bun run website        # the public website's dev server on port 3001
bun run website:build  # the website prerendered to static HTML in website/dist/client: / in Arabic, /en in English
```
