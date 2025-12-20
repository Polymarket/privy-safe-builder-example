"use client";

import { useTrading } from "@/providers/TradingProvider";
import Header from "@/components/Header";
import PolygonAssets from "@/components/PolygonAssets";
import TradingSession from "@/components/TradingSession";
import MarketTabs from "@/components/Trading/MarketTabs";
import GeoBlockedBanner from "@/components/GeoBlockedBanner";

export default function Home() {
  const {
    tradingSession,
    currentStep,
    sessionError,
    isTradingSessionComplete,
    initializeTradingSession,
    endTradingSession,
    eoaAddress,
    isGeoblocked,
    isGeoblockLoading,
    geoblockStatus,
  } = useTrading();

  return (
    <div className="p-6 min-h-screen flex flex-col gap-6 max-w-7xl mx-auto">
      <Header onEndSession={endTradingSession} />

      {/* Show geoblock banner if user is in blocked region */}
      {isGeoblocked && !isGeoblockLoading && (
        <GeoBlockedBanner geoblockStatus={geoblockStatus} />
      )}

      <PolygonAssets />

      {/* Hide trading session initialization when geoblocked */}
      {!isGeoblocked && (
        <TradingSession
          session={tradingSession}
          currentStep={currentStep}
          error={sessionError}
          isComplete={isTradingSessionComplete}
          initialize={initializeTradingSession}
          endSession={endTradingSession}
        />
      )}

      {/* Markets are viewable even when geoblocked, but trading buttons should be disabled */}
      {(isTradingSessionComplete || isGeoblocked) && eoaAddress && (
        <MarketTabs />
      )}
    </div>
  );
}
