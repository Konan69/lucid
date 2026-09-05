import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Api } from "./api";

export function useResource<T>(api: Api, path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    try {
      const next = await api.request<T>(path);
      if (current === generation.current) {
        setData(next);
        setError("");
      }
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load this. Try again.",
        );
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [api, path]);
  useEffect(() => {
    setData(undefined);
    setLoading(true);
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 15_000);
    return () => {
      ++generation.current;
      inFlight.current = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);
  return { data, error, loading, refresh };
}
