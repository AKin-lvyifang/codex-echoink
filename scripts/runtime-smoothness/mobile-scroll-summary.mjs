/** Classify native gestures by delivered touch events, not CDP command staging. */
export function summarizeMobileScroll(diagnostic) {
 const {writes,touches}=diagnostic;
 const start=touches.find(t=>['outer-gesture','outer-held'].includes(t.stage)&&t.type==='touchstart');
 const move=touches.find(t=>start&&t.t>=start.t&&t.stage==='outer-gesture'&&t.type==='touchmove');
 const end=touches.find(t=>start&&t.t>=start.t&&['touchend','touchcancel'].includes(t.type));
 if(!start)throw Error('Native outer touch start missing');
 const complete=!!move&&!!end;
 const outer=w=>/eis-scroll|echoink-ipad-content/.test(w.cls);
 const control=w=>outer(w)&&w.t>=start.t&&(complete?w.t<=end.t:['outer-held','outer-gesture'].includes(w.stage));
 const held=w=>control(w)&&(complete?w.t<move.t:w.stage==='outer-held');
 const gesture=w=>control(w)&&(complete?w.t>=move.t:w.stage==='outer-gesture');
 const inertia=w=>outer(w)&&w.stage==='inertia-window'&&w.t>=(end?.t??start.t);
 const groups=new Map();
 for(const w of writes.filter(w=>w.before!==w.after)) {const key=w.id+':'+w.frame;groups.set(key,(groups.get(key)??0)+1);}
 return {rawWrites:writes.length,actualWrites:writes.filter(w=>w.before!==w.after).length,maxActualPerTargetFrame:Math.max(0,...groups.values()),
 outerWritesDuringGesture:writes.filter(w=>gesture(w)&&w.before!==w.after).length,
 outerWritesInInertiaWindow:writes.filter(w=>inertia(w)&&w.before!==w.after).length,
 outerRawWritesWhileHeld:writes.filter(held).length,outerRawWritesDuringGesture:writes.filter(gesture).length,
 outerRawWritesInInertiaWindow:writes.filter(inertia).length,firstMovePaused:move?.paused??null,
 outerStageWritesBeforeTouch:writes.filter(w=>outer(w)&&w.stage==='outer-gesture'&&w.t<start.t).length,
 nativeTouchWindow:{complete,start:start.t,firstMove:move?.t??null,end:end?.t??null,basis:complete?'native-events':'touch target detached; command stages after native start'}};
}
