# profile-routing

A server-only Paseo provider. An agent on `profile-routing/auto` is a router: each message runs
capitally-dev's model-pick against the daemon's profiles and live usage, creates a delegate from
the best profile of the selected tier **in the same workspace**, and then either waits for that
delegate or lets it run on its own.

Schedules pin a provider at creation time. Pointing a schedule at this provider defers the real
provider choice until the run fires.

No settings screen and no client UI. The router's timeline uses built-in `user_message`,
`notification`, and `assistant_message` items.

## Modes

| Mode | What happens |
| --- | --- |
| **Relay** (default) | Wait for the delegate and publish its final text as this turn's last assistant message. |
| **Handoff** | Start the delegate, complete this turn immediately, then archive the router a few seconds later. |
| **Detach** | Start the delegate and complete this turn immediately. The router stays. |

Thinking options `min`, `medium` (default), `high`, and `max` map to model-pick tiers
`agent low`, `agent medium`, `agent high`, and `agent max`. There is no `agent min` tier.

An info notification always names the chosen profile, provider, model, and delegate id. The
assistant message is the run's final text: the delegate's answer in relay, or that same routing
note in handoff and detach so the run output still says where the work went.

## Schedules

`relay` works with the default schedule settings: the run waits on the **router** agent, and
`archiveOnFinish` (default true) archives the run workspace after that agent is idle.

`handoff` and `detach` need `archiveOnFinish: false`. Otherwise the schedule archives the whole
run workspace when the router finishes, including a delegate that is still working. Set that from
the app or with `paseo schedule update` after create.

A router used as `target: agent` (an existing agent) must use **detach**, never **handoff**.
Archiving the router makes the next run fail with a gone target.

## Environment

The plugin subprocess inherits the daemon environment (`~/.paseo/agent.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROFILE_ROUTING_MODEL_PICK` | `~/.agents/skills/model-pick/scripts/api.ts` | Module that exports `pickProfiles` |
| `PROFILE_ROUTING_RELAY_TIMEOUT_MINUTES` | `120` | How long relay waits for the delegate |
| `PROFILE_ROUTING_ARCHIVE_DELAY_SECONDS` | `3` | Delay before handoff archives the router |

## Install

```bash
paseo plugin add panrafal/paseo-plugins:profile-routing
```

From a checkout on the daemon machine:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/profile-routing
```

Then `paseo plugin ls` should show `running`, and `paseo models` should list `profile-routing/auto`.
After source edits: `npm run typecheck --workspace=profile-routing` and
`paseo plugin reload profile-routing`.
