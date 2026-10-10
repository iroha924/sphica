# Governance

Sphica is maintained by one person. This page says who decides what, and how a decision is made.

## Roles

| Role | Who | What they do |
|---|---|---|
| Maintainer | [@iroha924](https://github.com/iroha924) | Decides what goes in. Reviews and merges pull requests, cuts releases and approves each publish to npm, answers vulnerability reports, and enforces the [code of conduct](https://github.com/iroha924/sphica/blob/main/CODE_OF_CONDUCT.md). |
| Contributor | Anyone who opens an issue or sends a pull request from a fork | Proposes changes and reports problems. Contributors have no write access to the repository. |
| Collaborator | Nobody yet | People who keep contributing may be invited by the maintainer, one person at a time. What a collaborator may do is decided when the first one is invited, and written here then. |

## How decisions are made

- The maintainer makes the final decision on every change, release, and policy.
- Proposals are made in public: an issue for a larger change or a change in direction, a pull request for a change that is ready. Anyone may comment on either.
- A change in behavior comes with automated tests. A change that may or may not help is an experiment: its issue states how it is measured and the bar for adopting it, it is measured before it is adopted, and the result is recorded on the issue either way. One that can only be judged in real use may ship as an option that is off by default, and stays or goes by how the trial measures.
- A pull request records what was decided and which options were rejected, with the reason for each, in its "Decisions" section.
- Vulnerabilities are reported and handled in private first, as [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) describes.
- A change to this document is proposed like any other change, and the maintainer decides.

## Continuity

If the maintainer dies, or can no longer look after the project, it can go on.

- A person the maintainer chose holds a way into the maintainer's GitHub and npm accounts, to be used only then. With it they can do what the maintainer does: handle issues and pull requests, and cut and approve releases.
- The same person is named as the account's successor in GitHub's settings, and has accepted. After the maintainer's death, GitHub lets a successor move the account's public repositories to an account of their own. A repository that has moved needs its release environment and npm's trusted publisher set up again before it can release.

That person's name is not published here.

## Where things are written

- How to contribute, and how review works: [CONTRIBUTING.md](https://github.com/iroha924/sphica/blob/main/CONTRIBUTING.md)
- What the project intends to do and not do: [ROADMAP.md](https://github.com/iroha924/sphica/blob/main/ROADMAP.md)
- How the software is built: [ARCHITECTURE.md](https://github.com/iroha924/sphica/blob/main/ARCHITECTURE.md)
- Why its security claims hold: [ASSURANCE.md](https://github.com/iroha924/sphica/blob/main/ASSURANCE.md)
