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

#### Manual editor verification
Successfully embedded Unlayer Builder using react-email-editor 2.1.3. Added a Paragraph component through drag-and-drop and edited its text to: Hello from Unlayer Agent Lab! Verified visually in Chrome at localhost:5173. Design persistence and JSON export have not yet been tested.

### Milestone 2 - Human Editing Verified
Successfully embedded Unlayer Builder using react-email-editor 2.1.3. The editor loaded in Chrome at localhost:5173. Dragged a Paragraph component onto the canvas and changed its text to Hello from Unlayer Agent Lab!
Result: PASS
Next: Test the saveDesign API to retrieve the actual design JSON.
