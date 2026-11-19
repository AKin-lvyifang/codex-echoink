import assert from 'node:assert/strict';

/** Keyboard occlusion changes the visible viewport, not the device's layout identity. */
export async function visualKeyboardProxy(c) {
 const identity=await c.evaluate(`(()=>{if(window.__mobileKeyboardProxy)throw Error('Keyboard proxy already active');const m=window.__mobileKeyboardProxy={height:visualViewport.height,descriptor:Object.getOwnPropertyDescriptor(visualViewport,'height')};Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>m.height});return {width:innerWidth,height:innerHeight,phone:document.body.classList.contains('is-phone'),tablet:document.body.classList.contains('is-tablet')};})()`);
 return {
  async resize(height) {
   const next=await c.evaluate(`(()=>{__mobileKeyboardProxy.height=${Number(height)};visualViewport.dispatchEvent(new Event('resize'));return {width:innerWidth,height:innerHeight,phone:document.body.classList.contains('is-phone'),tablet:document.body.classList.contains('is-tablet')};})()`);
   assert.deepEqual(next,identity,'Keyboard proxy must preserve layout and phone/tablet identity');
  },
  async restore() {await c.evaluate(`(()=>{const m=window.__mobileKeyboardProxy;if(!m)return;if(m.descriptor)Object.defineProperty(visualViewport,'height',m.descriptor);else delete visualViewport.height;delete window.__mobileKeyboardProxy;visualViewport.dispatchEvent(new Event('resize'));})()`);}
 };
}
