// worker 补丁：把 BYOK 模型的 legacy 网关请求改道到本机模型桥。
export const BRIDGE_URL = 'http://127.0.0.1:17895/v1/chat/completions';

const ANCHOR = 'let I=$8i(o,w,p,f,r);try{';
const START = 'let I=$8i(o,w,p,f,r);if(A.custom_model){';
const START_LEGACY = 'let I=$8i(o,w,p,f,r);if(process.env.BYOK_MODEL_SHIM_URL&&A.custom_model){';
const END = '}try{k=I.url';

const BRANCH = `let I=$8i(o,w,p,f,r);if(A.custom_model){const B8="${BRIDGE_URL}",B9=A.custom_model||{},B10=(B9.parameters&&B9.parameters.api_key)||B9.api_key||"",B11=x=>{if(!x)return null;if("text"===x.type)return{type:"text",text:typeof x.text=="string"?x.text:""};if("image_url"===x.type){const y=x.image_url||{};return{type:"image_url",image_url:{url:y.url||x.url||"",...(y.detail||x.detail)?{detail:y.detail||x.detail}:{}}}}if("input_audio"===x.type){const y=x.input_audio||{};return{type:"input_audio",input_audio:{data:y.data||"",format:y.format||"wav"}}}return null},B12=x=>typeof x=="string"?x:Array.isArray(x)?x.map(B11).filter(Boolean):Array.isArray(x&&x.parts)?x.parts.map(B11).filter(Boolean):"",B13=(A.messages||[]).map(y=>{const t={role:y.role,content:B12(void 0===y.content?y.contents:y.content)};return y.name&&(t.name=y.name),y.tool_calls&&(t.tool_calls=y.tool_calls),y.tool_call_id&&(t.tool_call_id=y.tool_call_id),y.reasoning_content&&(t.reasoning_content=y.reasoning_content),t}),B14={},B15=A.parameters||{};for(const y of["max_tokens","max_completion_tokens","temperature","top_p","top_k","presence_penalty","frequency_penalty","parallel_tool_calls","response_format","tool_choice","stop","seed","user","reasoning_effort"])void 0!==B15[y]&&(B14[y]=B15[y]);Array.isArray(A.tools)&&A.tools.length>0&&(B14.tools=A.tools),Array.isArray(A.messages)&&!A.messages.some(y=>"system"===y.role)&&"string"==typeof A.system&&A.system&&B13.unshift({role:"system",content:A.system});const B16=JSON.stringify({model:B9.model||"byok",messages:B13,stream:!0,stream_options:{include_usage:!0},...B14}),B17={"Content-Type":"application/json",Accept:"text/event-stream",Authorization:"Bearer "+B10,...(B9.style?{"x-byok-style":B9.style}:{}),...(B9.url?{"x-byok-upstream":B9.url}:{})};return await(l?.(t)),await F.send({url:B8,transport:"legacy",body:B16,headers:B17,config:{enabled:!1},signal:t,requestId:A.request_id,onRequestCompression:null,dispatch:(n,o)=>za({operation:"sendRemoteChatAsk",endpointType:"infer",method:"POST",requestClass:"infer-sse",url:B8,requestId:A.request_id,init:{method:"POST",headers:o,body:n,signal:t}})})\n`;

function findStart(src) {
  const modern = src.indexOf(START);
  const legacy = src.indexOf(START_LEGACY);
  if (modern >= 0) return modern;
  if (legacy >= 0) return legacy;
  return -1;
}

export function isPatched(src) {
  return src.includes(BRIDGE_URL) || src.includes('BYOK_MODEL_SHIM_URL');
}

export function applyPatch(src) {
  const start = findStart(src);
  if (start >= 0) {
    const end = src.indexOf(END, start);
    if (end < 0) throw new Error('补丁结尾锚点缺失，worker 版本可能已变化');
    return src.slice(0, start) + BRANCH + src.slice(end);
  }
  const count = src.split(ANCHOR).length - 1;
  if (count !== 1) throw new Error(`补丁起始锚点数量异常（${count}）`);
  return src.replace(ANCHOR, BRANCH + '}try{');
}

export function removePatch(src) {
  const start = findStart(src);
  if (start < 0) return src;
  const end = src.indexOf(END, start);
  if (end < 0) throw new Error('补丁结尾锚点缺失，无法回滚');
  return src.slice(0, start) + 'let I=$8i(o,w,p,f,r);' + src.slice(end + 1);
}

// 旧版 BYOK 校验补丁：让客户端允许保存自定义模型并视账号为已开通 BYOK。
const AUX_PATCHES = [
  {
    name: 'vkn',
    from: 'async function vkn(A,e,t,i,r,n,o,s){',
    to: 'async function vkn(A,e,t,i,r,n,o,s){if(1)return;',
  },
  {
    name: 'Asg',
    from: 'function Asg(A,e){return',
    to: 'function Asg(A,e){return {...A,featureSwitches:{...A.featureSwitches,allow_byok:2}};return',
  },
  {
    name: 'normalizeUserStatus',
    from: ';let i={featureSwitches:{allow_byok:t},',
    to: ';t=2;let i={featureSwitches:{allow_byok:t},',
  },
  {
    name: 'Ttg',
    from: 'return{featureSwitches:{allow_byok:t},',
    to: 'return{featureSwitches:{allow_byok:2},',
  },
  {
    name: 'byokVision',
    from: '{supportsVision:l.is_vl}',
    to: '{supportsVision:l.is_vl||!g||(()=>{try{const{DatabaseSync:N1s}=process.getBuiltinModule("node:sqlite"),P1s=process.getBuiltinModule("node:path"),O1s=process.getBuiltinModule("node:os"),D1s=P1s.join(process.env.APPDATA||P1s.join(O1s.homedir(),"AppData","Roaming"),"QwenWorkCN","data","agents.db"),db1=new DatabaseSync(D1s,{readOnly:!0}),row1=db1.prepare("select is_vl from byok_custom_models where model = ? limit 1").get(g.model);return db1.close(),!(!row1||!row1.is_vl)}catch{return!0}})()}',
  },
];

export function applyAuxPatches(src) {
  let out = src;
  const warnings = [];
  for (const patch of AUX_PATCHES) {
    if (out.includes(patch.to)) continue;
    const count = out.split(patch.from).length - 1;
    if (count === 1) {
      out = out.replace(patch.from, patch.to);
    } else {
      warnings.push(`${patch.name}: 锚点数量 ${count}`);
    }
  }
  return { src: out, warnings };
}

export function removeAuxPatches(src) {
  let out = src;
  const warnings = [];
  for (const patch of AUX_PATCHES) {
    if (!out.includes(patch.to)) continue;
    const count = out.split(patch.to).length - 1;
    if (count === 1) {
      out = out.replace(patch.to, patch.from);
    } else {
      warnings.push(`${patch.name}: 补丁片段数量 ${count}`);
    }
  }
  return { src: out, warnings };
}
