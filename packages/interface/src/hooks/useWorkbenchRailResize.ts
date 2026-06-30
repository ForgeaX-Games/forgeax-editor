import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'forgeax.layout.wbDrawerW';
const ICON_RAIL_WIDTH = 60;
const MIN_WIDTH = 200;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 300;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

/** Preview WorkbenchLeftRail drawer width + drag resizer. */
export function useWorkbenchRailResize() {
  const [drawerWidth, setDrawerWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const widthRef = useRef(drawerWidth);
  widthRef.current = drawerWidth;

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: drawerWidth };
      setResizing(true);
      document.body.classList.add('wb-sidebar-resizing');
    },
    [drawerWidth],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      const next = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, dragRef.current.startW + delta),
      );
      setDrawerWidth(next);
    };

    const onUp = () => {
      if (dragRef.current) {
        try {
          localStorage.setItem(STORAGE_KEY, String(widthRef.current));
        } catch {
          /* ignore */
        }
      }
      dragRef.current = null;
      setResizing(false);
      document.body.classList.remove('wb-sidebar-resizing');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  return {
    drawerWidth,
    resizing,
    onResizeStart,
    iconRailWidth: ICON_RAIL_WIDTH,
  };
}
