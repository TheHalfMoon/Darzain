export type LibraryAsset = {
  id:string; name:string; kind:'image'|'video'|'audio'|'reference'; url?:string|null;
  duration?:number; trimInSeconds?:number; trimOutSeconds?:number;
  projectName:string; projectPath?:string|null; origin:'current'|'recent';
  source?:string; detail?:string; generatedBy?:string; prompt?:string;
};
