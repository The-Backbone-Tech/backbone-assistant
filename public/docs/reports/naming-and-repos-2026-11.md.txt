# Naming, repositories and vocabulary: research for decisions

Written 11 November 2026 for Backbone's owner and its coding agents. Web research, sources fetched or searched the same day. Every claim has a label:

- **Fact** means a primary source read today. The source is cited, and quotes are near-verbatim from the fetched page.
- **Reported** means a secondary source or search snippet. The primary source was not read.
- **Interpretation** means my reading and recommendation for Backbone.

Nothing here was changed in GitHub or anywhere else. Context observed with a read-only `gh repo list The-Backbone-Tech` on 11 November 2026: nine private repositories (`backbone`, `backbone-next`, `backbone-arena`, `backbone-work-planes`, `backbone-way`, `backbone-engine`, `backbone-kernel`, `company-cases-demo`, `backbone-base`). Only `backbone-base` lists a homepage, a Vercel URL.

## 1. Product category: what to call it

### What products call themselves

| Product | Own words (source, read 11 Nov 2026) | Category word |
| --- | --- | --- |
| OpenClaw | GitHub About: "The AI that really does things. Any OS. Any Platform." README heading: "Your assistant, on your devices, in your chats." First sentence: "OpenClaw is an open-source AI assistant that runs on your own computer and meets you in the channels you already use" ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)). Site headline: "The AI that really does things." Tagline: "Open source · Runs on your machine · Nobody's business model" ([openclaw.ai](https://openclaw.ai/)). | assistant |
| OpenClaw Enterprise | "a self-hosted, open-source extension layer that adds enterprise governance, security, and intelligence to the OpenClaw personal AI assistant". It is plugins, not a fork ([project docs](https://szaher.github.io/openclaw-enterprise/getting-started/what-is-openclaw)). Reported, from a search snippet of the project's own site. | assistant + governance layer |
| Hermes Agent (Nous Research) | "The Agent That Grows With You". "One agent, one memory, every surface." Neither "assistant" nor "operating system" appears on the page ([hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/)). | agent |
| goose (Block) | "goose is a general-purpose AI agent that runs on your machine". About: "an open source, extensible AI agent that goes beyond code suggestions" ([github.com/block/goose](https://github.com/block/goose)). | agent |
| Lindy | "Lindy is the AI employee that plugs into your tools, learns how you work, and takes real work off your plate" ([lindy.ai](https://www.lindy.ai/)). | AI employee |
| Devin | "Meet Devin, your team's autonomous software engineer" ([devin.ai](https://devin.ai/)). | role (engineer) |
| Manus | Headline "Less structure, more intelligence". Title "Manus: Hands On AI". "General AI agent" does not appear on the homepage today ([manus.im](https://manus.im/)). | none on page |
| ChatGPT agent | "Introducing ChatGPT agent: bridging research and action", 17 July 2025 ([openai.com](https://openai.com/index/introducing-chatgpt-agent/)). Reported, from a search snippet; the page was not fetched. | agent |
| Claude Cowork | Launched 12 January 2026 as a research preview. Anthropic called it "Claude Code for non-technical knowledge work", per coverage ([Techzine](https://www.techzine.eu/news/applications/137859/anthropic-introduces-cowork-for-general-knowledge-work)). Reported. | coworker / agent |

**Pattern (interpretation).** Products about doing a person's work end to end lead with a familiar noun:

- "assistant": OpenClaw.
- "agent": Hermes, goose, ChatGPT agent.
- a job role: Lindy's "AI employee", Devin's "software engineer".

Each then follows with a concrete verb or channel claim: "really does things", "on your devices, in your chats", "takes real work off your plate". None of the leading open-source personal agents uses "operating system" as its category word. The closest is a user showcase heading on openclaw.ai, "Personal Operating System With Daily Briefings".

### Is "AI operating system" used, and does it confuse?

**Used: yes, mostly by enterprise vendors and commentators.** Reported, from search results on 11 November 2026, not each read:

- Asana's "operating system for human-agent teams".
- DingTalk's "Agent OS", December 2025.
- Slack's "agentic OS".
- A StationX ranking that treats "agentic OS", "personal AI", "AI assistant" and "second brain" as names for the same idea ([stationx](https://app.stationx.net/articles/agentic-os)).

The lineage is Karpathy's "LLM OS" analogy, where the LLM is the kernel process. That is a technical metaphor, not a product category (reported via secondary write-ups).

**Confusion: direct evidence that writers must disarm it.**

- **Fact.** The Neuron's DevDay piece by Grant Harvey, 30 September 2026, is headlined "ChatGPT is becoming an AI operating system". The body then has to say "Not an operating system in the literal Windows/macOS sense" and "The computer is still underneath. The apps still exist" ([theneuron.ai](https://www.theneuron.ai/news/openai-devday-2026-chatgpt-is-becoming-an-ai-operating-system/)). The phrase OS is the writer's, not OpenAI's.
- **Fact.** Knowlee's 2026 essay (no date or author on the page) calls the OS label "more of a marketing convenience than a technical claim". It warns that "readers infer a level of operational maturity that has not been built", and that "For people who expect 'OS' to imply portability, the word is misleading" ([knowlee.ai](https://www.knowlee.ai/blog/is-the-os-metaphor-right-for-ai-agents)).
- **Gap.** I found no reader study or survey measuring this confusion. The evidence is writers pre-empting it, and critics calling the term marketing.

**Interpretation for Backbone.** "Operating platform" in the README's first sentence carries the same risk in a softer form:

- A first reader hears infrastructure or an OS, not "something that does my work".
- It is also a coined compound. The repository's own writing rule ("familiar words first") argues against it.

Keep "platform" for the technical layer: Kernel, Engine, Backbone. Lead the public sentence with "assistant", the word OpenClaw, the reference Backbone names, uses for the same job. "Agent" is the second-best choice: accurate, but in 2026 it also means coding agents and protocol agents. "JARVIS" is useful as an aside, but not as the category. No reference product uses it on its homepage, and it is a trademarked fictional character.

### Candidate one-sentence descriptions

1. **"Backbone is an open-source AI assistant that does real work for a person, a team or a company, using the tools and accounts they already have, and keeps a receipt for everything it does."**
   This uses the same nouns and verbs as OpenClaw ("AI assistant", "really does things", "channels you already use") and Lindy ("plugs into your tools ... takes real work off your plate"). Readers get a familiar category plus a differentiator, receipts.
2. **"Backbone is an open AI assistant you run yourself: give it a job from your desktop, terminal or chat, and it gets it done with the tools you already pay for, asking once for permission and never twice."**
   This leads with the job journey, as OpenClaw's "your devices, your chats" and goose's "runs on your machine" do. It suits a page aimed at individual users.
3. **"Backbone is an open-source AI assistant for people and companies, like a JARVIS that works across your apps, with the company controls (permissions, audit, export) that personal agents lack."**
   This positions against OpenClaw Enterprise's governance layer and uses "JARVIS" as an analogy only. Its risk: the trademark, and the fact that it sets science-fiction expectations.

Recommendation (interpretation): use 1 as the README and GitHub description, and 2 for the app and onboarding. Test them cheaply before settling. Give each sentence alone to 5 or more fresh readers or fresh model sessions, and ask them "what does this product do, and what does it replace?" If anyone answers "an operating system" or "infrastructure", the sentence fails.

## 2. Monorepo or several repositories when agents write the code

### Primary guidance

- **Fact. Claude Code** ["Set up Claude Code in a monorepo or large codebase"](https://code.claude.com/docs/en/large-codebases), read 11 Nov 2026:
  - It treats one large tree as the normal case. Layering: a root `CLAUDE.md` for rules that apply everywhere, plus a per-directory file per package that loads on demand.
  - `claudeMdExcludes` skips other teams' files. `worktree.sparsePaths` checks out only the needed directories.
  - Other repositories are reached with `--add-dir` or `additionalDirectories`. A directory added that way does **not** load its `CLAUDE.md` or rules unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set; the `additionalDirectories` setting never loads them.
  - For changes across packages: "Give Claude the whole change in one session ... keeps the decisions behind each edit consistent".
- **Fact. Claude Code memory docs** ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)):
  - Ancestor `CLAUDE.md` files load at launch. Subdirectory files load once Claude touches a file there.
  - Since v2.1.277, Claude Code reads `AGENTS.md` directly, but only when there is no `CLAUDE.md` in the working directory or any directory above it. Otherwise it reads `CLAUDE.md` only, unless that file imports `@AGENTS.md`. A third-party guide claiming Claude Code "still" ignores `AGENTS.md` (August 2026) is out of date.
- **Fact. Codex** ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md), the redirect target of developers.openai.com/codex/guides/agents-md):
  - Codex walks from the Git root down to the working directory and takes at most one file per directory. Nearer files come later and take precedence.
  - It stops adding files at `project_doc_max_bytes`, 32 KiB by default.
  - Its advice: "Place overrides as close as possible to the specialized work."
- **Fact. AGENTS.md standard** ([agents.md](https://agents.md/)): "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." It is stewarded by the Agentic AI Foundation under the Linux Foundation, and supported by Codex, Cursor, Amp, Jules, Factory, Devin, goose, Gemini CLI, Copilot and others.
- **Reported. OpenAI, "Harness engineering"** (Ryan Lopopolo, 11 Feb 2026, [openai.com/index/harness-engineering](https://openai.com/index/harness-engineering/); the page returned 403 to my fetcher):
  - Per search excerpts of the page, a short `AGENTS.md` (about 100 lines) "serves primarily as a map" to deeper sources of truth in a structured in-repo `docs/` directory treated as the system of record.
  - Charlie Guo's summary ([Artificial Ignorance, 22 Feb 2026](https://www.ignorance.ai/p/the-emerging-harness-engineering)) says the team avoided "a single giant instruction file". It adds that a background agent opened PRs to fix stale docs.
- **Fact. Cognition (Devin)** knowledge base: projects needing several repositories put them on the same machine snapshot under `$HOME/repos/` ([knowledge.cognition.ai](https://knowledge.cognition.ai/articles/5095130098-projects-that-require-multiple-repos-to-be-on-the-same-machine)). Reported, from a search snippet. The same pattern, "clone all repos into one workspace and add a root CLAUDE.md", appears in practitioner posts as a "virtual monorepo".
- **Factory** keeps a per-repository summary (structure, packages, build commands) for every connected repository ([factory.ai/context-window-problem](https://www.factory.ai/context-window-problem)). Reported.
- **Google**, Potvin and Levenberg, "Why Google stores billions of lines of code in a single repository", CACM, July 2016. This is the canonical case for one tree: unified versioning, one source of truth, atomic cross-project changes, and large-scale refactoring, at the cost of heavy tooling investment. It predates 2025, and its page returned 403 today, so it is cited from prior knowledge.
- **Vendor advocacy, weight accordingly.**
  - Nx ([nx.dev](https://nx.dev/blog/the-effect-of-monorepos-on-the-effectiveness-of-ai-agents)) and monorepo.tools argue that a repository boundary blinds agents to context across projects. Nx sells monorepo tooling, and in June 2026 launched "Polygraph", a "synthetic monorepo" across repositories (reported).
  - Augment suggests a hybrid: core in one repository, experiments outside ([augmentcode.com](https://www.augmentcode.com/guides/monorepo-vs-polyrepo-ai-s-new-rules-for-repo-architecture)).

### Evidence on context files themselves

- **Fact.** Gloaguen, Mündler-Sasahara, Müller, Raychev and Vechev (ETH Zurich and LogicStar.ai), "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?", [arXiv:2602.11988](https://arxiv.org/abs/2602.11988), v1 12 Feb 2026, v3 29 Sep 2026:
  - "providing context files does not generally improve task success rates". They raised inference cost by more than 20% on average.
  - Agents follow the instructions well, but repository overviews were not helpful. The files are useful for non-standard practices.
- **Fact.** Mitchell Hashimoto, ["My AI adoption journey"](https://mitchellh.com/writing/my-ai-adoption-journey), 5 Feb 2026: "harness engineering". In his `AGENTS.md`, "Each line in that file is based on a bad agent behavior, and it almost completely resolved them all." Each line is paired with a script that lets the agent verify its own work.
- **Fact.** Claude Code best practices ([code.claude.com/docs/en/best-practices](https://code.claude.com/docs/en/best-practices)):
  - Its list of things not to do includes "Describe your architecture and file layout in `CLAUDE.md`", because "Claude reads the repo itself".
  - Keep only what Claude cannot work out from the code. The memory guide sets a target of "under 200" lines per file.
- **Fact.** Armin Ronacher, ["Agentic Coding Recommendations"](https://lucumr.pocoo.org/2025/6/12/agentic-coding/), 12 June 2025: put critical tools in a `Makefile`, and "Tools must clearly inform agents of misuse or errors". The post says nothing on monorepo versus several repositories.

### Interpretation for Backbone

**One repository for everything a unit's journey touches.** Every agent harness above resolves instructions by walking the directory tree of one checkout. Across a repository boundary, three things are lost:

- instruction inheritance (Codex walks up to the Git root only; Claude Code's added directories skip their `CLAUDE.md` by default);
- atomic commits and a single gate run;
- grep-based discovery.

Backbone's own rules already require a unit to own "every file its journey needs, across layers". Today's split repositories (`backbone` for docs and owners, `backbone-next` for code, and `-kernel`, `-engine`, `-arena`, `-way`, `-work-planes`) make that the expensive path. The concrete cost: a doc change and its code change cannot land in one commit or one gate.

Suggested target:

- one product repository holding code, docs, `GOAL.md`, execution and Arena evidence;
- one short root `AGENTS.md` that works as a map, with nested `AGENTS.md` only where a package has non-standard practices;
- an `@AGENTS.md` import in any `CLAUDE.md`, so both harnesses read one source.

Keep separate repositories only for things with a different lifecycle or audience:

- published third-party plugins;
- a public website;
- historical archives.

Bulky dated evidence can live in the repository under private development records or `evidence/`, or in a separate archive repository if size hurts clones. The decision rule is "Does an agent need it in the same change?"

Keep the root map well under Codex's 32 KiB cutoff, and do not restate the layout. Both the ETH study and Anthropic's docs say overviews do not pay.

## 3. Retiring and renaming repositories on GitHub

### Renaming

Facts from ["Renaming a repository"](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), read 11 Nov 2026:

- "all existing information, with the exception of project site URLs, is automatically redirected to the new name". This covers issues, wikis, stars and followers.
- Git clone, fetch and push to the old URL keep working: "operations targeting the previous location will continue to function as if made on the new location".
- **GitHub Pages project sites are not redirected.** GitHub recommends a custom domain so the URL survives renames.
- **Actions:** GitHub "will not redirect calls to an action hosted by a renamed repository". Workflows using it fail with "repository not found". GitHub suggests making a new repository for the action and archiving the old one.
- **Local clones:** GitHub "strongly recommend[s]" running `git remote set-url origin NEW_URL`.
- **Reusing the old name** (a new repository under the original name) breaks the redirects.
- Only organization owners or repository admins can rename.

The page is silent on the following points:

- **Webhooks and GitHub Apps.** Interpretation: they are bound to the repository, not its name, so they keep firing. Receivers that key on `full_name`, and hard-coded URLs in scripts, CI or submodules, need updating.
- **Vercel.** Community threads report "Git Disconnected" after a rename; the fix is to disconnect and reconnect the repository in the project's Git settings ([Vercel community](https://community.vercel.com/t/how-to-fix-vercel-git-disconnected-error-after-repository-was-deleted-or-renamed/38014)). Reported; this is not official documentation. Relevant to `backbone-base`, which has a Vercel homepage.
- **Netlify.** The documented path is Project configuration → Build & deploy → Continuous deployment → Repository → Manage repository → "Link to a different repository" ([docs.netlify.com](https://docs.netlify.com/build/git-workflows/repo-permissions-linking)). Reported; community posts say branch deploy settings may need re-entering.

### Archiving

Facts from ["Archiving repositories"](https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories):

- Archiving makes the repository "read-only for all users and indicate[s] that it's no longer actively maintained". Issues, pull requests, code, labels, milestones, projects, wiki and releases all become read-only.
- Collaborators and teams cannot be changed. Users can still fork and star.
- It is reversible: "You can also unarchive repositories".
- GitHub recommends that you "close all issues and pull requests, as well as update the README file and description" **before** archiving, because afterwards changes require unarchiving.
- On legacy per-repository plans, archived private repositories still bill.

The topics page ([Classifying with topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)) sets the limits: lowercase letters, digits and hyphens; 50 characters or fewer; 20 topics at most.

### Best practice (interpretation, assembled from the facts above)

1. **Decide the successor first.** Merge what lives on into the product repository with history preserved: `git subtree add` or `git filter-repo` into a subdirectory, so `git log` and blame stay intact.
2. **Mark the old repository before archiving it**, because archived repositories are read-only. Make these changes:
   - **Description:** "ARCHIVED (11 Nov 2026). Superseded by The-Backbone-Tech/<successor>. Historical record only."
   - **Topics:** `archived`, `superseded`, `backbone-history`.
   - **README banner** at the top: "This repository is archived and read-only. Its content moved to <link> on <date> at commit <sha>. Do not take work from here."
   - **The repository's `AGENTS.md`** replaced with a three-line redirect telling agents not to act there and where to go. An archived repository can still be cloned, and an agent landing in it reads that file first.
   - Close or transfer open issues and pull requests.
3. **Archive; do not delete.** Archiving is reversible and keeps evidence, which matches Backbone's "keep failed runs, keep evidence" rule.
4. **Rename only when the name itself misleads**, and never reuse a freed name. Before renaming:
   - grep all repositories, scripts, CI, `package.json` and git submodules for the old `owner/name`;
   - check Pages, Actions references, Vercel or Netlify links and webhook receivers;
   - afterwards run `git remote set-url` in every local checkout and worktree.
   On the shared Mac this includes the worktrees under `$HOME/Documents/Codex/...`.
5. **Prefer fewer names.** If `backbone-next` becomes the product repository, it may be cleaner to move its content into `backbone`, keeping the plain name, and archive `backbone-next`. Renaming `backbone-next` to `backbone` would require first freeing the name, which breaks the old `backbone` redirects.

## 4. One vocabulary for agents and people

- **Fact.** Fowler, ["UbiquitousLanguage"](https://martinfowler.com/bliki/UbiquitousLanguage.html), 31 Oct 2006, summarising Evans's Domain-Driven Design:
  - "a common, rigorous language between developers and users", which "should be based on the Domain Model used in the software";
  - "using the ubiquitous language in conversations with domain experts is an important part of testing it";
  - it "should evolve as the team's understanding of the domain grows".
- **Fact. Anthropic, Skill authoring best practices** ([platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)), read 11 Nov 2026. This is the most direct primary guidance on synonyms and LLMs:
  - "Use consistent terminology. Choose one term and use it throughout". The bad examples given are mixing "API endpoint, URL, API route, path", and mixing "extract, pull, get, retrieve". The reason given: "Consistency helps Claude parse and follow instructions."
  - The same page:
    - "Claude is already very smart. Only add context Claude doesn't already have";
    - avoid time-sensitive text, and put history in an "Old patterns" section;
    - keep references one level deep;
    - avoid vague names such as "helper", "utils" and "tools";
    - "Name files descriptively".
- **Fact. Claude Code memory docs:**
  - "The more specific and concise your instructions, the more consistently Claude follows them."
  - "if two instructions contradict each other, Claude may pick one arbitrarily".
  - Target under 200 lines.
- **Fact. Claude Code best practices:**
  - adding IMPORTANT or ALL CAPS to a missed line "mostly makes Claude over-apply the rule";
  - a rule that cannot bend belongs in a hook;
  - a line lost in a long file means the file must be shorter.
- **Fact. Codex AGENTS.md guide:** "Keep instructions concise and focused on reusable working agreements".
- **Retrieval (reported).** Claude Code's team replaced vector search with agentic grep in 2025: Boris Cherny's statements, via secondary write-ups such as [smartscope.blog](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/). Interpretation: lexical search finds only the word you search for. A concept named "unit", "slice" and "journey" in different files is three separate searches, and an agent that greps one term silently misses the other two.
- **Research on phrasing sensitivity (reported).** Studies show that LLM outputs change under meaning-preserving paraphrase, for example EMNLP 2024 ([arXiv:2406.19898](https://arxiv.org/abs/2406.19898)). A 2025 preprint ([arXiv:2509.01790](https://arxiv.org/abs/2509.01790)) argues that much measured sensitivity is an evaluation artifact. I found no study that isolates terminology inconsistency inside agent instruction files. Treat the synonym cost as well-grounded vendor guidance plus a strong retrieval argument, not a measured effect size.

### Interpretation for Backbone

- Keep **one glossary owner**, a single section or file: one preferred term per concept, its plain gloss, and the retired synonyms marked "do not use".
- Have a check in `pnpm check` flag the retired synonyms in new text. This is the kind of mechanical enforcement Anthropic and OpenAI both recommend over emphasis.
- Prefer field-standard words. Examples:
  - "assistant" and "agent" over "operating platform";
  - "permission" or "approval" over a coined term for a signature;
  - "audit log" or "receipt".
  Keep a coined term (Kernel, Arena) only with its gloss beside it, which the repository's `AGENTS.md` already asks for.
- Keep `AGENTS.md` and `CLAUDE.md` to what an agent cannot infer: commands, misleading places, decisions not in code, and repeated corrections. Point to owners; do not restate them.
  - Hashimoto's rule is a good admission test: each line traces to an observed bad behaviour.
  - The ETH result is the reason to measure before adding more.

## Sources (all accessed 11 November 2026)

**Products**
- OpenClaw: https://github.com/openclaw/openclaw and https://openclaw.ai/
- OpenClaw Enterprise: https://szaher.github.io/openclaw-enterprise/getting-started/what-is-openclaw
- Hermes Agent: https://hermes-agent.nousresearch.com/
- goose: https://github.com/block/goose
- Lindy: https://www.lindy.ai/
- Devin: https://devin.ai/
- Manus: https://manus.im/
- ChatGPT agent: https://openai.com/index/introducing-chatgpt-agent/
- Claude Cowork coverage: https://www.techzine.eu/news/applications/137859/anthropic-introduces-cowork-for-general-knowledge-work

**"AI operating system" usage and critique**
- The Neuron: https://www.theneuron.ai/news/openai-devday-2026-chatgpt-is-becoming-an-ai-operating-system/
- Knowlee: https://www.knowlee.ai/blog/is-the-os-metaphor-right-for-ai-agents
- StationX: https://app.stationx.net/articles/agentic-os

**Agent instructions and repositories**
- Claude Code large codebases: https://code.claude.com/docs/en/large-codebases
- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- AGENTS.md: https://agents.md/
- OpenAI harness engineering: https://openai.com/index/harness-engineering/ (403; excerpts only)
- Guo summary: https://www.ignorance.ai/p/the-emerging-harness-engineering
- Gloaguen et al.: https://arxiv.org/abs/2602.11988
- Hashimoto: https://mitchellh.com/writing/my-ai-adoption-journey
- Ronacher: https://lucumr.pocoo.org/2025/6/12/agentic-coding/
- Cognition: https://knowledge.cognition.ai/articles/5095130098-projects-that-require-multiple-repos-to-be-on-the-same-machine
- Factory: https://www.factory.ai/context-window-problem
- Nx: https://nx.dev/blog/the-effect-of-monorepos-on-the-effectiveness-of-ai-agents
- Augment: https://www.augmentcode.com/guides/monorepo-vs-polyrepo-ai-s-new-rules-for-repo-architecture

**GitHub, Vercel, Netlify**
- Rename: https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- Archive: https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories
- Topics: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
- Vercel community: https://community.vercel.com/t/how-to-fix-vercel-git-disconnected-error-after-repository-was-deleted-or-renamed/38014
- Netlify: https://docs.netlify.com/build/git-workflows/repo-permissions-linking

**Vocabulary**
- Fowler: https://martinfowler.com/bliki/UbiquitousLanguage.html
- Anthropic skill best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Agentic search write-up: https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/
