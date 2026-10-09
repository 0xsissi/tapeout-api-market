import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUiLanguage } from '../../../i18n/language.js';

import { RoleStep } from './RoleStep.js';

describe('RoleStep', () => {
  beforeEach(() => setUiLanguage('zh'));
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all onboarding role choices', () => {
    const app = render(<RoleStep onSelect={vi.fn()} />);
    const frame = app.lastFrame();

    expect(frame).toContain('买家');
    expect(frame).toContain('卖家');
    expect(frame).toContain('两者都要');
    app.unmount();
  });
});
