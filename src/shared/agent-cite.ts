/** 助手回答里的出处标记：[[q:题目ID]]、[[lesson:课次ID]]、[[stu:学员编号]]。主进程校验、界面渲染共用这一份写法 */
export type CiteKind = 'q' | 'lesson' | 'stu' | 'query'
export const CITE_PATTERN = '\\[\\[(query|q|lesson|stu):([^\\]\\s\\[]{1,64})\\]\\]'
