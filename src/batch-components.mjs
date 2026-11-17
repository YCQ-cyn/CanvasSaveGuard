// React components are injected into the matched native canvas bundle. Media
// stays in its existing node objects; presentation never creates extra files.
import { selectionToolbarPosition } from './selection-layout.mjs';

export function createBatchComponents(React, jsx, NativeNode, NativeCard, Lines, NativeToolbar, useTheme = () => null) {
  function usePresence(expanded) {
    const [present, setPresent] = React.useState(expanded);
    React.useLayoutEffect(() => {
      if (expanded) { setPresent(true); return; }
      const timer = setTimeout(() => setPresent(false), 280);
      return () => clearTimeout(timer);
    }, [expanded]);
    return { present: expanded || present, closing: !expanded };
  }

  function Results({ node, expanded, scale, onView, onSetPrimary, onDuplicate, onDownload, onRetry, onDelete }) {
    const { present, closing } = usePresence(expanded);
    if (!present) return null;
    return jsx.jsxs(React.Fragment, { children: [
      jsx.jsx(Lines, { node, scale, closing }),
      ...(node.metadata?.images || []).map((image, index) => {
        if (node.metadata.guardBatchChildren?.[image.id]) return null;
        const position = batchImagePosition(node, image.id, index);
        return jsx.jsxs(React.Fragment, { children: [
          jsx.jsx(NativeCard, {
            node, image, index, scale, guardClosing: closing,
            onView: () => onView?.(image.id), onSetPrimary: () => onSetPrimary?.(image.id),
            onDuplicate: () => onDuplicate?.(image.id), onDownload: () => onDownload?.(image.id),
            onRetry: () => onRetry?.(image.id), onDelete: () => onDelete?.(image.id),
          }),
          ...['target', 'source'].map(side => jsx.jsx('div', {
            'data-guard-batch-port': side,
            'data-guard-batch-node': node.id,
            'data-guard-batch-image-id': image.id,
            title: side === 'source' ? '连接或延伸子图' : '连接到子图',
            style: {
              position: 'absolute',
              left: position.x + (side === 'source' ? node.width : 0) - 24,
              top: position.y + node.height / 2 - 24,
              width: 48, height: 48, zIndex: 40,
              display: 'grid', placeItems: 'center', cursor: 'crosshair',
              pointerEvents: closing ? 'none' : 'auto',
            },
            onPointerDown: event => event.stopPropagation(),
            onMouseDown: event => globalThis.CanvasSaveGuardBatch?.beginConnection(event, node.id, image.id, side),
            children: jsx.jsx('div', {
              style: { width: 12, height: 12, borderRadius: '50%', border: '2px solid #9ca3af', background: '#242320' },
            }),
          }, side)),
        ] }, image.id);
      }),
    ] });
  }

  function Node({ guardParent: parent, ...props }) {
    const node = props.data;
    const mapped = parent?.metadata?.guardBatchChildren?.[node.metadata?.guardBatchImageId] === node.id;
    const root = mapped || parent?.metadata?.isBatchRoot && parent.metadata.batchChildIds?.includes(node.id) ? parent : null;
    const expanded = !root || (mapped ? root.metadata.imageBatchExpanded !== false : !!root.metadata.imageBatchExpanded);
    const { present, closing } = usePresence(expanded);
    const firstMount = React.useRef(true);
    React.useLayoutEffect(() => {
      const initial = firstMount.current;
      firstMount.current = false;
      if (!root || !present) return;
      if (mapped && initial && expanded) return;
      const element = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!element) return;
      const index = mapped ? root.metadata.images.findIndex(image=>image.id===node.metadata.guardBatchImageId) : root.metadata.batchChildIds.indexOf(node.id);
      element.dataset.guardBatchClosing = String(closing);
      const animation = animateBatchCard(element, { x: node.position.x - root.position.x, y: node.position.y - root.position.y }, index, closing);
      return () => animation?.cancel();
    }, [root?.id, expanded, present]);
    if (!present) return null;
    return jsx.jsxs(React.Fragment, { children: [
      jsx.jsx(NativeNode, props),
      root && props.isSelected && node.metadata?.content ? jsx.jsx('button', {
        type: 'button', title: '设为展示图', 'data-canvas-no-zoom': true,
        style: { position: 'absolute', left: node.position.x + 8, top: node.position.y + 8, zIndex: 75, borderRadius: 7, padding: '5px 8px', background: '#242320e8', color: '#fafaf9', border: '1px solid #78716c', cursor: 'pointer' },
        onPointerDown: event => event.stopPropagation(), onMouseDown: event => event.stopPropagation(),
        onClick: event => { event.stopPropagation(); globalThis.CanvasSaveGuardBatch?.setLegacyPrimary(node.id); },
        children: '设为展示图',
      }) : null,
    ] });
  }
  function Toolbar(props) {
    const [count,setCount]=React.useState(()=>globalThis.CanvasSaveGuardBatch?.selectionCount()||0);
    const [downloading,setDownloading]=React.useState(false);
    const theme = useTheme();
    const toolbar = React.useRef(null);
    const reposition = React.useRef(null);
    reposition.current = () => {
      const element = toolbar.current;
      if (!element) return;
      const geometry = globalThis.CanvasSaveGuardBatch?.selectionScreenBounds(props.guardViewport, props.guardSelection, props.guardNodes);
      if (!geometry) return;
      element.style.maxWidth = `${Math.max(120, geometry.canvas.right - geometry.canvas.left - 24)}px`;
      const obstacles = [];
      for (const hostId of ['canvas-save-guard', 'local-canvas-retry-panel']) {
        const host = document.getElementById(hostId);
        const section = host?.shadowRoot?.querySelector('section');
        if (section && host.getBoundingClientRect().height) obstacles.push(section.getBoundingClientRect());
      }
      for (const item of document.querySelectorAll('[data-node-toolbar],[data-node-panel],[data-guard-native-selection-toolbar]')) {
        const rect = item.getBoundingClientRect();
        if (rect.width && rect.height) obstacles.push(rect);
      }
      const position = selectionToolbarPosition(geometry.selection, geometry.canvas, element.getBoundingClientRect(), obstacles);
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
      element.style.visibility = 'visible';
    };
    React.useLayoutEffect(() => {
      reposition.current();
      globalThis.CanvasSaveGuardRetryRegion?.paint(props.guardViewport);
    });
    React.useEffect(()=>{
      const update=event=>{setCount(event.detail);reposition.current();};
      window.addEventListener('canvas-guard-batch-selection',update);
      return()=>window.removeEventListener('canvas-guard-batch-selection',update);
    },[]);
    React.useEffect(() => {
      const update = () => reposition.current();
      window.addEventListener('resize', update);
      const observer = new ResizeObserver(update);
      for (const id of ['canvas-save-guard', 'local-canvas-retry-panel']) {
        const section = document.getElementById(id)?.shadowRoot?.querySelector('section');
        if (section) observer.observe(section);
      }
      return () => { window.removeEventListener('resize', update); observer.disconnect(); };
    }, []);
    const batch = globalThis.CanvasSaveGuardBatch;
    const status = props.selectedCount + count ? batch?.selectionStatus(props.guardSelection, props.guardNodes) : null;
    const buttonStyle = { padding: '5px 9px', minHeight: 30, border: '1px solid #8885', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer' };
    const stopPointer = event => event.stopPropagation();
    const action = (label, onClick, disabled, title) => jsx.jsx('button', {
      type: 'button', disabled, style: { ...buttonStyle, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' },
      onClick, title,
      children: label,
    }, label);
    return jsx.jsxs('div', { 'data-guard-batch-toolbar': true, style: { display: 'contents' }, children: [
      jsx.jsx(NativeToolbar, { ...props, guardNativeSelectedCount: props.selectedCount, selectedCount: props.selectedCount + count }),
      props.selectedCount + count ? jsx.jsx('div', {
        'data-guard-arrange-toolbar': true,
        ref: toolbar,
        style: { position: 'fixed', zIndex: 85, visibility: 'hidden', width: 'max-content', pointerEvents: 'none' },
        children: jsx.jsxs('div', {
          style: { pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, padding: 7, maxWidth: '100%', border: '1px solid', borderColor: theme?.toolbar.border || '#78716c', borderRadius: 11,
            background: theme?.toolbar.panel || '#242320', color: theme?.toolbar.item || '#fafaf9', fontSize: 12, boxShadow: '0 5px 18px #0002' },
          onPointerDown: stopPointer, onMouseDown: stopPointer,
          onKeyDown: event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); },
          children: [
            action('一键展开', () => batch?.setSelectionExpanded(true), !status?.groupCount, '展开选中的图片组'),
            action('一键收起', () => batch?.setSelectionExpanded(false), !status?.groupCount, '收起选中的图片组'),
            action('整理', () => batch?.arrangeSelection(), !status?.canArrange,
              !status?.allCollapsed ? '请先将选中的图片组全部收起' : '按原行列中线对齐，以最大图为参照，保留空位，最大占位之间间隔半格（24 画布单位）'),
            action(downloading?'正在下载…':'批量下载', async () => {
              setDownloading(true);
              try { await batch?.downloadSelection(); } finally { setDownloading(false); }
            },downloading||!status?.imageCount,'将所选图片打包为 ZIP，选中的收起图片组包含整组已有原图'),
            status?.emptyImageCount > 1 ? jsx.jsx('div', {
              'data-guard-batch-reference-hint': true,
              style: { flexBasis: '100%', textAlign: 'center', fontSize: 11, opacity: 0.8 },
              children: `将参考图连到任一空图片节点，即可连接所选 ${status.emptyImageCount} 个空节点`,
            }) : null,
          ],
        }),
      }) : null,
    ] });
  }
  return { Results, Node, Toolbar };
}
