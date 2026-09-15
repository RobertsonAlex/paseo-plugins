# profile-routing

A Paseo provider whose agent is a router. Each message runs a **model script** from plugin
settings with `EFFORT` in the environment, creates a delegate from the JSON that script prints
**in the same workspace**, and then either waits for that delegate or lets it run on its own.

Schedules pin a provider at creation time. Pointing a schedule at this provider defers the real
provider choice until the run fires.

The router's timeline uses built-in `user_message`, `notification`, and `assistant_message` items.
Configure models and timeouts under **Settings → Plugins → profile-routing**, or **Configure
profile routing** in the Command Center.

## Modes

| Mode | What happens |
| --- | --- |
| **Relay** (default) | Wait for the delegate and publish its final text as this turn's last assistant message. |
| **Handoff** | Start the delegate, complete this turn immediately, then archive the router a few seconds later. |
| **Detach** | Start the delegate and complete this turn immediately. The router stays. |

Thinking options `min`, `medium` (default), `high`, and `max` are passed to the model script as
`EFFORT`. `min` becomes `low` so a command such as `--tier "agent $EFFORT"` matches `agent low`.

An info notification names the chosen settings model, provider, and delegate id. The assistant
message is the run's final text: the delegate's answer in relay, or that same routing note in
handoff and detach so the run output still says where the work went.

## Models

Each settings model has an id (the catalog model, for example `profile-routing/claude`) and a
shell command. The command runs with `/bin/sh -c` and `EFFORT` in its environment. It must print
the agent config Paseo creates agents with, which the plugin passes through unchanged:

```json
{
  "provider": "claude",
  "model": "claude-opus-5",
  "modeId": "auto",
  "thinkingOptionId": "low"
}
```

Only `provider` is required, in either form Paseo accepts: joined as `"claude/claude-opus-5"`, or a
bare `"claude"` with `model` as its own field. `modeId`, `thinkingOptionId`, `featureValues`,
`providerOptions`, `systemPrompt`, `title`, `mcpServers`, and `toolPolicy` are optional and
forwarded as given; a `title` names the delegate instead of the generated one. Unknown fields are
dropped, and `cwd` stays the router's workspace. A non-zero exit, empty stdout, invalid JSON, or a
missing `provider` fails the router turn (and **Test**).

Shipped default:

```text
claude: echo '{"provider":"claude","model":"claude-opus-5","modeId":"auto","thinkingOptionId":"$EFFORT"}'
```

The first model in the list is the catalog default. The `claude` line is a minimal example.

**Test** on a model card runs that script with `EFFORT=medium` and checks that stdout is an agent
config with a provider. It shows the `provider/model` the delegate would use and the parsed config,
or the error; it does not start an agent.

## Schedules

`relay` works with the default schedule settings: the run waits on the **router** agent, and
`archiveOnFinish` (default true) archives the run workspace after that agent is idle.

`handoff` and `detach` need `archiveOnFinish: false`. Otherwise the schedule archives the whole
run workspace when the router finishes, including a delegate that is still working. Set that from
the app or with `paseo schedule update` after create.

A router used as `target: agent` (an existing agent) must use **detach**, never **handoff**.
Archiving the router makes the next run fail with a gone target.

## Settings storage

Timeouts and models are stored under
`$PASEO_HOME/plugin-data/profile-routing/settings.json`.

| Field | Default | Meaning |
| --- | --- | --- |
| `relayTimeoutMinutes` | `120` | How long relay waits for the delegate |
| `archiveDelaySeconds` | `3` | Delay before handoff archives the router |
| `models` | `claude` as above | Catalog models and their scripts |

## Install

```bash
paseo plugin add panrafal/paseo-plugins:profile-routing
```

From a checkout on the daemon machine:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/profile-routing
```

Then `paseo plugin ls` should show `running`, and `paseo provider models profile-routing` should
list the configured model ids. After source edits: `npm run typecheck --workspace=profile-routing`
and `paseo plugin reload profile-routing`.
