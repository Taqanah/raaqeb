---
status: accepted
---

# The 240 MB floor applies to the default profile; heavier features are optional capabilities

Raaqeb promises to run one monitor on 1 vCPU and 240 MB RAM. That promise covers the **default profile**: everything enabled on a fresh install. Features that cannot fit the floor (headless browser checks, and anything else that needs a large process or an external engine) are not rejected; they ship as **optional capabilities**: off by default, enabled deliberately by the operator, with their extra resource cost stated at the point of enabling. Every monitor type and feature is tagged core or optional, and optional capabilities must be isolatable so that a disabled capability costs nothing at runtime.

## Considered options

- Reject every feature that cannot fit the floor. Rejected: it would block features users want, such as browser checks, on machines that can afford them.
- Raise the floor. Rejected: the floor is the product's promise to the smallest self-hoster.

## Consequences

- The footprint benchmark measures the default profile only, and it runs at release time on the maintainer's machine; there is no CI.
- Architecture must keep optional capabilities behind a boundary.
- Docs state requirements per capability, not one number for the whole product.
