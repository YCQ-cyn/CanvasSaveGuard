// Only sidebar rows are windowed. The canvas, selection/export arrays and
// persistence retain every node, including offscreen and collapsed contents.
export function useSidebarWindow(React, items, mode, filter) {
  const ref=React.useRef(null);
  const [view,setView]=React.useState({top:0,height:800,width:264,step:0,columns:0});
  const frame=React.useRef(0);
  const grid=mode==='grid', enabled=items.length>100;
  const measure=React.useCallback(()=>{
    const element=ref.current;if(!element)return;
    const content=element.firstElementChild,first=content?.querySelector('[data-node-item]');
    const columns=grid&&content?getComputedStyle(content).gridTemplateColumns.split(' ').filter(Boolean).length:1;
    const step=first?first.getBoundingClientRect().height+(grid?8:6):0;
    const next={top:element.scrollTop,height:element.clientHeight,width:element.clientWidth,step,columns};
    setView(previous=>Object.keys(next).every(key=>Math.abs(next[key]-previous[key])<0.5)?previous:next);
  },[grid]);
  const onScroll=React.useCallback(()=>{if(!frame.current)frame.current=requestAnimationFrame(()=>{frame.current=0;measure();});},[measure]);
  React.useLayoutEffect(()=>{
    const element=ref.current;if(!element)return;
    element.scrollTop=0;measure();
    const observer=new ResizeObserver(measure);observer.observe(element);
    return()=>{observer.disconnect();cancelAnimationFrame(frame.current);frame.current=0;};
  },[mode,filter,measure]);
  React.useLayoutEffect(()=>{measure();},[items.length,mode]);
  const columns=grid?(view.columns||Math.max(1,Math.floor((view.width-16)/96))):1;
  const step=view.step||(grid?(view.width-24-(columns-1)*8)/columns+28.5:62);
  const rows=Math.ceil(items.length/columns),overscan=4;
  const start=enabled?Math.max(0,Math.min(rows-1,Math.floor(view.top/step)-overscan)):0;
  const end=enabled?Math.min(rows,Math.ceil((view.top+view.height)/step)+overscan):rows;
  return {ref,onScroll,items:enabled?items.slice(start*columns,end*columns):items,
    style:enabled?{paddingTop:start*step,paddingBottom:Math.max(0,(rows-end)*step)}:undefined};
}
