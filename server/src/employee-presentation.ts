export const richText = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\`*_{}\[\]()#+.!|~=-])/gu, "\\$1");
type Candidate = {id:number; name:string; path?:string; lastName?:string; position?:string; email?:string; active?:boolean};
export function candidatePresentation(kind:"people"|"departments", items:readonly Candidate[], complete:boolean) {
  const noun=kind==="departments"?"Отдел":"Сотрудник";
  const options=items.map((v,i)=>({id:String(v.id), label:`${noun} ${i+1}`, reply:`Выбрать ${kind==="departments"?"отдел":"сотрудника"} ID ${v.id}`}));
  const groups:Array<{lines:string[];indices:number[]}>=[{lines:[],indices:[]}];
  items.forEach((v,i)=>{
    const name=[v.name,v.lastName].filter(Boolean).join(" ");
    const detail=v.path??[v.position,v.email,v.active === undefined ? undefined : v.active ? "Активен" : "Уволен"].filter(Boolean).join(" · ");
    const line=`${i+1}. **${richText(name)}**\n${richText(detail)}`;
    let group=groups.at(-1)!;
    if(group.lines.length && group.lines.join("\n\n").length+line.length>2800){group={lines:[],indices:[]};groups.push(group);}
    group.lines.push(line);group.indices.push(i);
  });
  const pages=groups.map(group=>{
    const selected=group.indices.map(i=>options[i]!);
    const buttons=selected.map(v=>`<tg-button type="callback_data" data="${v.reply}">${v.label}</tg-button>`);
    const rows:string[]=[];for(let i=0;i<buttons.length;i+=2)rows.push(`<tg-button-row>${buttons.slice(i,i+2).join("")}</tg-button-row>`);
    return {markdown:`**${kind==="departments"?"Выберите подразделение":"Выберите сотрудника"}**\n\n${group.lines.join("\n\n")||"В этой порции вариантов нет."}\n\n${complete?"Выберите вариант. Недостающие данные можно написать следующим сообщением.":"Поиск ещё не завершён. Это найденные варианты; доступны следующие порции."}\n\n${rows.join("\n")}\n<tg-button type="callback_data" data="Отменить выбор сотрудника">Отмена</tg-button>`, options:[...selected,{id:"cancel",label:"Отмена",reply:"Отменить выбор сотрудника"}]};
  });
  return {...pages[0]!,pages,choiceIsApproval:false};
}
