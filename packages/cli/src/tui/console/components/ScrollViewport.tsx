import { Box, measureElement, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { theme } from '../../../theme.js';

const ScrollContext = createContext<{ reveal: (node: DOMElement) => void; height: number; width: number } | null>(null);

// Input fields and selected menu rows reveal themselves without moving the frame.
export function useScrollTarget(active: boolean, revision?: unknown) {
  const ref = useRef<DOMElement>(null);
  const context = useContext(ScrollContext);
  useEffect(() => {
    if (active && ref.current) context?.reveal(ref.current);
  }, [active, revision, context?.reveal, context?.height, context?.width]);
  return ref;
}

export function ScrollViewport({ children, height, followOutput = false }: {
  children: ReactNode;
  height: number;
  followOutput?: boolean;
}) {
  const contentRef = useRef<DOMElement>(null);
  // Ink handles an initially null ref; its public hook type omits that initial state.
  const { height: contentHeight, width: contentWidth } = useBoxMetrics(contentRef as RefObject<DOMElement>);
  const visibleRows = Math.max(1, height - 1);
  const [offset, setOffset] = useState(0);
  const previousMaximum = useRef(0);
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const maximum = Math.max(0, contentHeight - visibleRows);
  const visibleOffset = Math.min(offset, maximum);

  useEffect(() => {
    const oldMaximum = previousMaximum.current;
    previousMaximum.current = maximum;
    setOffset(current => followOutput && current >= oldMaximum ? maximum : Math.min(current, maximum));
  }, [maximum, followOutput]);

  const reveal = useCallback((node: DOMElement) => {
    const content = contentRef.current;
    if (!content) return;
    let top = 0;
    let ancestor: DOMElement | undefined = node;
    while (ancestor && ancestor !== content) {
      top += ancestor.yogaNode?.getComputedTop() ?? 0;
      ancestor = ancestor.parentNode;
    }
    if (ancestor !== content) return;
    const rows = visibleRowsRef.current;
    const bottom = top + measureElement(node).height;
    const limit = Math.max(0, measureElement(content).height - rows);
    setOffset(current => Math.max(0, Math.min(limit,
      top < current ? top : bottom > current + rows ? bottom - rows : current,
    )));
  }, []);
  const context = useMemo(() => ({ reveal, height: contentHeight, width: contentWidth }), [reveal, contentHeight, contentWidth]);

  useInput((_input, key) => {
    if (key.pageUp) setOffset(current => Math.max(0, current - Math.max(1, visibleRows - 1)));
    if (key.pageDown) setOffset(current => Math.min(maximum, current + Math.max(1, visibleRows - 1)));
  });

  return (
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      <Box height={visibleRows} flexDirection="column" flexShrink={0} overflow="hidden">
        <Box ref={contentRef} width="100%" flexDirection="column" flexShrink={0} marginTop={-visibleOffset}>
          <ScrollContext.Provider value={context}>{children}</ScrollContext.Provider>
        </Box>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {maximum > 0
          ? `PgUp/PgDn 翻页 · ${visibleOffset + 1}–${Math.min(contentHeight, visibleOffset + visibleRows)} / ${contentHeight} 行`
          : '↑↓ 选择操作 · Enter 执行'}
      </Text>
    </Box>
  );
}
