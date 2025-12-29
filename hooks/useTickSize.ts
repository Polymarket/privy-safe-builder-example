import { useState, useEffect, useCallback } from "react";
import { ClobClient } from "@polymarket/clob-client";
import { CLOB_API_URL, POLYGON_CHAIN_ID } from "@/constants/polymarket";

export default function useTickSize(tokenId: string | null) {
  const [tickSize, setTickSize] = useState<number>(0.01);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTickSize = useCallback(async () => {
    if (!tokenId) return;

    setIsLoading(true);
    try {
      const client = new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID);
      const result = await client.getTickSize(tokenId);
      const parsed = typeof result === "string" ? parseFloat(result) : result;
      if (parsed && !isNaN(parsed) && parsed > 0) {
        setTickSize(parsed);
      }
    } catch (error) {
      console.warn("Failed to fetch tick size, using default:", error);
    } finally {
      setIsLoading(false);
    }
  }, [tokenId]);

  useEffect(() => {
    fetchTickSize();
  }, [fetchTickSize]);

  return { tickSize, isLoading, refetch: fetchTickSize };
}

