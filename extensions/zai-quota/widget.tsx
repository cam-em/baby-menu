import type { RefreshableBabyMenuWidget } from "@babymenu/contracts";
import { ZaiQuotaView } from "./components";
import { refreshZaiQuota } from "./store";

export const zaiQuotaWidget = {
  id: "zai-quota",
  title: "Z.AI · GLM",
  viewRefreshIntervalMs: 600_000,
  refreshView: refreshZaiQuota,
  render: () => <ZaiQuotaView />,
} satisfies RefreshableBabyMenuWidget;
