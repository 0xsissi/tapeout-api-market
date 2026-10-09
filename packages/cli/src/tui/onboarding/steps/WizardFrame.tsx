import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import type { PropsWithChildren } from 'react';

import { theme } from '../../../theme.js';

interface WizardFrameProps extends PropsWithChildren {
  step: number;
  totalSteps: number;
  title: string;
  subtitle?: string;
  footer?: string;
}

export function WizardFrame({ step, totalSteps, title, subtitle, footer, children }: WizardFrameProps) {
  const ratio = totalSteps > 0 ? Math.max(1, Math.round((step / totalSteps) * 24)) : 1;
  const progress = `${'='.repeat(ratio)}${'-'.repeat(Math.max(0, 24 - ratio))}`;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box borderStyle="single" borderColor={theme.primary} flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={theme.primary}>Tapeout API Market (TAM) Onboarding</Text>
        <Text>
          Step {step} / {totalSteps} <Text color={theme.accent}>[{progress}]</Text>
        </Text>
        <Box marginTop={1}>
          <Text bold>{title}</Text>
        </Box>
        {subtitle ? (
          <Box marginTop={1}>
            <Text color={theme.muted}>{subtitle}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
        {footer ? (
          <Box marginTop={1}>
            <Text color={theme.muted}>{footer}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
