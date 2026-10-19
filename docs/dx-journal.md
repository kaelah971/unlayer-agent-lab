# Unlayer DX Journal

## Goal

Build a real agent-native Unlayer integration while documenting the developer experience, contribution opportunities, and ecosystem gaps.

## Build Log

### Day 1

#### What I tried

#### What I expected

#### What happened

#### What confused me

#### What worked well

#### Possible documentation gap

#### Possible contribution

#### Notes

---

## Contribution Candidates

## Bugs / Friction

## Questions for Unlayer

## Developer Ecosystem Observations

#### What happened
Vite scaffolded the app with TypeScript 7.0.2, but typescript-eslint 8.71.2 required TypeScript below 6.1.0, so npm failed with ERESOLVE. We changed TypeScript to 6.0.3, reinstalled successfully, then verified the baseline with npm run build and npm run lint.

#### What confused me
The starter generator selected dependency versions that were incompatible with each other.

#### What worked well
After aligning TypeScript to 6.0.3, installation, build, and lint all passed cleanly.
