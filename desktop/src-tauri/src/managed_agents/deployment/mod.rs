//! Roster and team deployment: the plan, its revalidation, and the narrow
//! patch apply performs.
//!
//! Split from `managed_agents` (file-size cap) alongside the other subsystem
//! modules. The pieces:
//!
//! * [`roster`] — the pure reconcile function shared by preview and apply.
//! * [`presets`] — the first-party team presets, keyed by slug.
//! * [`activation`] — the machine-local proof record that gates a profile.

pub(crate) mod activation;
pub(crate) mod presets;
pub(crate) mod roster;

#[cfg(test)]
#[path = "installed_store_tests.rs"]
mod installed_store_tests;

#[cfg(test)]
mod tests;


