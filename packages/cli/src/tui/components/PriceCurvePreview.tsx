import { Box } from 'ink';
import { Text } from '../../i18n/Text.js';
import { PAYMENT_TOKEN } from '@clawmarket/shared';

function cucPrice(p0: number, utilization: number, alpha: number): number {
  const u = Math.min(Math.max(utilization, 0), 0.999);
  return p0 / ((1 - u) ** alpha);
}

export function PriceCurvePreview({
  p0,
  alpha,
  currentU,
}: {
  p0: number;
  alpha: number;
  currentU?: number;
}) {
  const samples = [0, 0.25, 0.5, 0.75, 0.9];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>价格预览</Text>
      {samples.map((utilization) => {
        const marker =
          currentU != null && Math.abs(currentU - utilization) < 0.1
            ? '  <- 现在'
            : '';
        return (
          <Text key={utilization}>
            {`u=${utilization.toFixed(2)}  ->  ${cucPrice(p0, utilization, alpha).toFixed(2)} ${PAYMENT_TOKEN.symbol} / 1M${marker}`}
          </Text>
        );
      })}
    </Box>
  );
}
