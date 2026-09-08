import * as React from "react";
import { useOS } from "@/state/os-store";
import type { HealthResponse } from "./core";

/** Provider connection states from the gateway (never secrets). Cached per store instance. */
export function useGatewayHealth(): { health: HealthResponse | null; error: string | null; loading: boolean; refresh: () => void } {
  const { gateway } = useOS();
  const [health, setHealth] = React.useState<HealthResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    gateway
      .health()
      .then((res) => {
        if (!active) return;
        if (res.ok) {
          setHealth(res);
          setError(null);
        } else setError(res.message);
      })
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [gateway, tick]);
  return { health, error, loading, refresh: () => setTick((t) => t + 1) };
}
