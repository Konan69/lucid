# Company and projects

2026-10-03: Historical agreed model; current Company/Membership and recursive Project behavior superseding the implementation context is in [docs/14](14-product-feature-set-and-grok-bot-parity.md) and `apps/server/src/companies`/`projects`; Teams and inherited-access choices are not settled by this audit.

**Status:** Product model agreed on 2 September 2026

## Shape

```text
Company
├── Members
├── Teams
│   └── Members
└── Projects
    ├── Members and participating teams
    ├── Threads
    └── Child projects
        ├── Threads
        └── Child projects recursively
```

The company is the organization and the top-level ownership boundary. Its members are ordinary
company members. Teams are subsets of those members.

A project is a real work container, not a tag and not a department. Projects may span departments
or teams. They can include members and participating teams, contain threads, and contain child
projects recursively.

No additional hierarchy level has been agreed. The current model uses the recursive Project tree.

## Inheritance

A child project inherits its parent's:

- members;
- permissions;
- context; and
- service access.

The exact override rule is still open: we have not decided whether a child may restrict inherited
access or may only add to what it inherits.

## Invariants

- Every Team and Project belongs to exactly one Company.
- A Team contains only members of its Company.
- A Project may involve multiple Teams and individual company Members.
- A child Project belongs to the same Company as its parent.
- A Project cannot be its own ancestor.
- A Thread may be located in a Project, including any child Project.
- Project membership is not inferred from department ownership; cross-functional projects are
  normal.

## Still to decide

- Whether child Projects may narrow inherited access.
- Whether every Thread must belong to a Project or may begin unfiled.
- Whether a Project can include only individual Members, only Teams, or both explicitly.
- What else a Project owns beyond Threads and inherited context: goals, files, routines, memory,
  milestones, or other durable work.
- Whether moving a Thread between Projects changes which inherited context and permissions apply
  to future work only or to its complete history.
