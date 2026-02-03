import { erc20Abi, formatUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/providers/WalletContext";
import { USDC_E_CONTRACT_ADDRESS, USDC_E_DECIMALS } from "@/constants/tokens";
import { QUERY_STALE_TIMES, QUERY_REFETCH_INTERVALS } from "@/constants/query";

export default function usePolygonBalances(address: string | undefined) {
  const { publicClient } = useWallet();

  const {
    data: usdcBalance,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["polygon-balances", address],
    queryFn: async () => {
      if (!address || !publicClient) return null;

      const balance = await publicClient.readContract({
        address: USDC_E_CONTRACT_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      });

      return balance;
    },
    enabled: !!address,
    staleTime: QUERY_STALE_TIMES.BALANCE,
    refetchInterval: QUERY_REFETCH_INTERVALS.BALANCE,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const formattedUsdcBalance = usdcBalance
    ? parseFloat(formatUnits(usdcBalance, USDC_E_DECIMALS))
    : 0;

  return {
    usdcBalance: formattedUsdcBalance,
    formattedUsdcBalance: formattedUsdcBalance.toFixed(2),
    rawUsdcBalance: usdcBalance,
    isLoading,
    isError: !!error,
  };
}
