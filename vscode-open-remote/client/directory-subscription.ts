/**
 * Keeps the daemon stream handles that `list({ subscribe: {} })` returns so they can be released
 * when the plugin client deactivates.
 *
 * The host assigns subscription IDs; passing one is rejected. The SDK's `agents.subscribe` and
 * `workspaces.subscribe` handlers only relay updates from an open list stream, so the first page
 * of a seed must ask for one. The pinned SDK types omit the returned handle, so it is read
 * structurally from the result.
 */

interface DirectorySubscription {
  release(): Promise<void>;
}

export interface SubscriptionKeeper {
  /** Stores the stream handle on `result`, or releases it at once if `release` already ran. */
  keep(result: object): void;
  /** Releases every kept stream; later `keep` calls release immediately. */
  release(): void;
}

function takeSubscription(result: object): DirectorySubscription | null {
  const candidate = (result as { subscription?: unknown }).subscription;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as DirectorySubscription).release === "function"
  ) {
    return candidate as DirectorySubscription;
  }
  return null;
}

function releaseQuietly(subscription: DirectorySubscription): void {
  void subscription.release().catch(() => undefined);
}

export function createSubscriptionKeeper(): SubscriptionKeeper {
  const subscriptions: DirectorySubscription[] = [];
  let released = false;
  return {
    keep(result) {
      const subscription = takeSubscription(result);
      if (!subscription) return;
      if (released) releaseQuietly(subscription);
      else subscriptions.push(subscription);
    },
    release() {
      released = true;
      for (const subscription of subscriptions.splice(0)) releaseQuietly(subscription);
    },
  };
}
