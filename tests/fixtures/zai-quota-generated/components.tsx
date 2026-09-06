import { Progress, Skeleton, StatusDot } from "@babymenu/ui";
import { useZaiQuota, type ZaiQuotaFailure, type ZaiQuotaWindow } from "./store";

const FAILURE_COPY: Record<ZaiQuotaFailure["status"], { title: string; detail: string }> = {
  "authentication-required": {
    title: "Z.ai quota needs a credential",
    detail: "configure the Z.ai environment or Baby Menu Keychain item, then restart",
  },
  "rate-limit": {
    title: "Z.ai quota is rate limited",
    detail: "the next visible refresh will try again",
  },
  "service-error": {
    title: "Z.ai quota service is unavailable",
    detail: "last-good quota stays visible when available",
  },
  "malformed-response": {
    title: "Z.ai quota format changed",
    detail: "no missing value was replaced with zero",
  },
  unavailable: {
    title: "Z.ai quota is unavailable",
    detail: "check connectivity and the configured source",
  },
};

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function checkedCopy(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "last checked --";
  return `last checked ${new Date(parsed).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function resetCopy(value: string | undefined): string {
  if (!value) return "reset --";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "reset --";
  return `resets ${new Date(parsed).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function WindowRow({ window }: { window: ZaiQuotaWindow }) {
  const remaining = window.percentRemaining;
  const label = window.label ?? `${window.type} · unit ${window.unit}`;
  return (
    <section className="flex flex-col gap-2" data-zai-window={window.id}>
      <div className="flex items-end justify-between gap-3">
        <span className="text-xxs uppercase tracking-caps text-ink-label">{label}</span>
        <span className="text-xxs text-ink-soft">
          {window.percentage === undefined ? "-- used" : `${percent(window.percentage)}% used`}
        </span>
      </div>
      <div className="flex items-baseline gap-1 text-ink-strong">
        <span className="text-2xl font-light tracking-value">{remaining === undefined ? "--" : percent(remaining)}</span>
        <span className="text-sm text-ink-soft">% remaining</span>
      </div>
      {remaining === undefined ? null : <Progress value={remaining} aria-label={`${label} remaining`} />}
      <div className="text-xxs text-ink-label">{resetCopy(window.resetAt)}</div>
    </section>
  );
}

export function ZaiQuotaView() {
  const view = useZaiQuota();
  const result = view.result;

  if (!result) {
    return (
      <article className="flex flex-col gap-3" data-zai-state="loading">
        <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
          <span>Z.AI · GLM</span>
          <span>checking</span>
        </div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-px w-full" />
      </article>
    );
  }

  if (!result.ok) {
    const copy = FAILURE_COPY[result.status];
    return (
      <article className="flex flex-col gap-3" data-zai-state={result.status}>
        <div className="flex items-center justify-between gap-2 text-xxs uppercase tracking-caps text-signal-danger">
          <span className="flex items-center gap-2">
            <StatusDot tone="danger" />
            <span>Z.AI · GLM</span>
          </span>
          {view.refreshing ? <span className="text-signal-warn">updating</span> : null}
        </div>
        <div className="text-sm text-ink-strong">{copy.title}</div>
        <div className="text-xs leading-5 text-ink-muted">{copy.detail}</div>
        <div className="text-xxs uppercase tracking-caps text-ink-label">{checkedCopy(result.checkedAt)}</div>
      </article>
    );
  }

  const stale = result.status === "stale" || result.data.stale;
  return (
    <article className="flex flex-col gap-4" data-zai-state={stale ? "stale" : "fresh"}>
      <div className="flex items-center justify-between text-xxs uppercase tracking-caps text-ink-label">
        <span>Z.AI · GLM</span>
        <span className={stale ? "flex items-center gap-1.5 text-signal-warn" : "flex items-center gap-1.5 text-signal-live"}>
          <StatusDot tone={stale ? "warn" : "live"} pulse={view.refreshing} />
          {view.refreshing ? "updating" : stale ? "stale" : "fresh"}
        </span>
      </div>
      {result.data.windows.map((window) => <WindowRow key={window.id} window={window} />)}
      {result.warning ? (
        <div className="text-xs leading-5 text-signal-warn">{FAILURE_COPY[result.warning.status].title}</div>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-xxs uppercase tracking-caps text-ink-label">
        <span>{checkedCopy(result.checkedAt)}</span>
        <span>{result.data.credentialSource === "baby-menu-keychain" ? "KEYCHAIN" : "ENV"}</span>
      </div>
    </article>
  );
}
