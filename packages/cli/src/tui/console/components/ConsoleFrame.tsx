import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import type { ReactNode } from 'react';

import { theme } from '../../../theme.js';
import { consoleNavItems, isCompactConsole, type ConsoleViewId } from '../lib.js';
import type { ConsoleEvent } from '../types.js';
import { EventsBar } from './EventsBar.js';
import { Nav } from './Nav.js';
import { Panel } from './Panel.js';
import { ScrollViewport } from './ScrollViewport.js';

export function ConsoleFrame({ columns, rows, header, status, currentView, navFocused, title, children, modal, events, footer, startup }: {
  columns: number;
  rows: number;
  header: ReactNode;
  status: ReactNode;
  currentView: ConsoleViewId;
  navFocused: boolean;
  title: string;
  children: ReactNode;
  modal?: { title: string; content: ReactNode };
  events: ConsoleEvent[];
  footer: string;
  startup?: { content: ReactNode; rows: number };
}) {
  // Keep one spare terminal row: a newline at the bottom must never scroll Windows Terminal.
  const height = Math.max(1, rows - 1);
  const eventsHeight = rows >= 28 ? 5 : 4;
  const bodyHeight = height - 3 - 1 - eventsHeight - 1;
  const compact = isCompactConsole(columns) || bodyHeight < consoleNavItems.length + 3;
  const navHeight = compact ? 1 : 0;
  const panelHeight = bodyHeight - navHeight;
  const tooSmall = columns < 40 || panelHeight < 6;
  const startupRows = startup ? Math.min(startup.rows, Math.max(0, panelHeight - 6)) : 0;

  return (
    <Box width={columns} height={height} paddingX={1} flexDirection="column" flexShrink={0} overflow="hidden">
      <Box height={3} flexShrink={0} overflow="hidden">{header}</Box>
      <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate-end">{status}</Text></Box>
      <Box height={Math.max(0, bodyHeight)} flexShrink={0} flexDirection="column" overflow="hidden">
        {tooSmall ? <Text>请放大终端窗口（至少 40 列、18 行）。</Text> : <>
          {compact ? <Box height={1} flexShrink={0}><Nav items={consoleNavItems} currentView={currentView} compact isFocused={navFocused && !modal} /></Box> : null}
          <Box height={panelHeight} flexShrink={0}>
            {!compact ? <>
              <Panel title="菜单" width={20} height={panelHeight}>
                <Nav items={consoleNavItems} currentView={currentView} compact={false} isFocused={navFocused && !modal} />
              </Panel>
              <Box width={1} flexShrink={0} />
            </> : null}
            <Panel title={modal?.title ?? title} flexGrow={1} height={panelHeight}>
              {startup && startupRows > 0 ? <Box height={startupRows} flexShrink={0} flexDirection="column" overflow="hidden">{startup.content}</Box> : null}
              <ScrollViewport key={modal ? `modal:${modal.title}` : currentView} height={panelHeight - 3 - startupRows} followOutput={!modal && currentView === 'chat'}>
                {modal?.content ?? children}
              </ScrollViewport>
            </Panel>
          </Box>
        </>}
      </Box>
      <Panel title="最近活动" height={eventsHeight}>
        <EventsBar events={events} limit={eventsHeight - 3} />
      </Panel>
      <Box height={1} flexShrink={0} overflow="hidden"><Text color={theme.muted} wrap="truncate-end">{footer}</Text></Box>
    </Box>
  );
}
