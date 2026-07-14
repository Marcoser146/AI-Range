import { useEffect, useState } from "react";
import { getHealth } from "../api/client";
import type { ApiConfig } from "../api/client";

type Status = "checking" | "ok" | "down";

export function HealthBanner({ config }: { config: ApiConfig }) {
  const [status, setStatus] = useState<Status>("checking");
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const health = await getHealth(config);
        if (!cancelled) {
          setStatus("ok");
          setTime(health.time);
        }
      } catch {
        if (!cancelled) setStatus("down");
      }
    }

    check();
    const interval = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [config.baseUrl]);

  return (
    <div className={`health-banner health-banner--${status}`}>
      <span className="dot" />
      {status === "checking" && "Checking gateway..."}
      {status === "ok" && `Gateway online${time ? ` (as of ${new Date(time).toLocaleTimeString()})` : ""}`}
      {status === "down" && "Gateway unreachable"}
    </div>
  );
}
