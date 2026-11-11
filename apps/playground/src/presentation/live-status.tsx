import type { SourceStatus } from '../adapters/live-source';
import { useT } from '../app-i18n';

/**
 * 标题栏里的数据源状态（docs/backend/R2-13、R3-12）：哪边的数据、连接状态、延迟、补发和丢弃。
 * 只用模拟器（Pages 现在的默认）时不显示。
 */
export function LiveStatusMetric({ status }: { status: SourceStatus | null }) {
  const t = useT();
  if (!status || status.mode === 'sim') return null;
  let text: string;
  if (status.source === 'sim') text = t('live.unavailable');
  else {
    const parts = [t('live.backend'), t(`live.state.${status.state === 'sim' ? 'idle' : status.state}`)];
    if (status.latencyMs !== undefined) parts.push(`${status.latencyMs} ms`);
    if (status.replayed > 0) parts.push(t('live.replayed', { value: status.replayed }));
    if (status.dropped > 0) parts.push(t('live.dropped', { value: status.dropped }));
    if (status.sourceOnline === false) parts.push(t('live.devicesOffline'));
    text = parts.join(' · ');
  }
  return (
    <span className="metric" data-testid="live-status" data-source={status.source} data-state={status.state}>
      {t('live.label')}: <b>{text}</b>
    </span>
  );
}
