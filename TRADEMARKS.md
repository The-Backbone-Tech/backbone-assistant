# Names and logos (proposed)

**Status:** a draft for the maintainer to decide, 26 Oct 2026. Nothing here is in force until it is accepted; until then only the Apache-2.0 licence ([LICENSE](LICENSE)) applies, and it grants no trademark rights (section 6).

## What is reserved

The names "Backbone" and "The Backbone", the `thebackbone` domains and any logo published for them. They identify this product and its authors. Reusing the code does not transfer those names.

## What you may do

- Use, change, rebrand and sell the code, under Apache-2.0. Keep the [NOTICE](NOTICE) file.
- Give your distribution its own name and look through its brand profile (see [docs/distributions.md](docs/distributions.md#white-label-rules)).
- Say truthfully that your product is "built on Backbone".

## What you may not do

- Call your product "Backbone", or a name that could be mistaken for it.
- Suggest that the Backbone authors endorse, certify or support your product unless they have said so in writing.
- Remove the NOTICE file or the credit in it.

## How it is enforced

Packages take visible names from the brand profile rather than hardcoding a reserved name: `scripts/contamination.mjs` fails the build if one does. A distribution sets its name only in its brand profile.
