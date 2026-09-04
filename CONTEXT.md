# Desktop Product Context

This context names the user-visible surfaces and comparison language used when evolving the desktop product without conflating lifecycle states or live data.

## Language

**Desktop surface**:
Any user-visible product state hosted by the desktop window, including transient status states and the ready application.
_Avoid_: Page, screen

**Boot status surface**:
The transient desktop surface shown while the product runtime is starting, recovering from startup failure, or stopping.
_Avoid_: Startup page, splash screen

**Workspace home surface**:
The ready desktop surface where a user selects a workspace or starts a session before entering an active conversation.
_Avoid_: Startup page, boot page

**Visual parity**:
Agreement with the approved legacy presentation in structure, sizing, spacing, typography, iconography, color, and material while allowing operating-system rendering variance and live product content.
_Avoid_: Pixel identity, similar appearance
