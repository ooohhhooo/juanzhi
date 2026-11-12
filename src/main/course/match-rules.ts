/**
 * 以课找知识点的「程序先认」这一步（规则 + 教材桥），不调用 AI，不依赖 electron，单测在内存库上直接跑。
 * AI 只在 service.ts 里对「规则没认出来 / 认得不够」的课做补充，补充后的候选再和这里的候选合并落库。
 */
import { bridgeCandidates, candidateScore, lessonsNeedingAi, mergeCandidates, ruleCandidates } from './match.ts'
import type { Candidate } from './match.ts'
import { applyLessonMatches, lessonRows } from './store.ts'
import type { KpTarget, LessonRow } from './store.ts'
import { MATCH_THRESHOLD } from './score.ts'
import type { CatalogEdition } from './textbook-builtin.ts'

type Db = any

export interface RulePass {
  lessons: LessonRow[]
  /** 规则 + 教材桥合并后的候选（还没落库） */
  candidates: Candidate[]
  /** 规则 / 教材桥认得不够、需要 AI 补充的课 */
  needAi: number[]
  /** 过线候选的个数 */
  strong: number
}

export function computeRulePass(db: Db, outlineId: string, subject: string, kps: KpTarget[], catalog: CatalogEdition[]): RulePass {
  const lessons = lessonRows(db, [outlineId])
  const codes = new Set(kps.map(k => k.code))
  const all: Candidate[] = []
  for (const l of lessons) all.push(...ruleCandidates(l, codes), ...bridgeCandidates(l, subject, catalog, codes))
  const candidates = mergeCandidates(all)
  return { lessons, candidates, needAi: lessonsNeedingAi(lessons.map(l => l.id), candidates), strong: candidates.filter(c => candidateScore(c) >= MATCH_THRESHOLD).length }
}

/** 规则 + 教材桥的结果落库（所有课、本次范围内的知识点）；返回落库统计 */
export function applyRulePass(db: Db, outlineId: string, pass: RulePass, kps: KpTarget[], meta: { rev: number; model: string; promptVersion: string }): { matched: number; none: number } {
  return applyLessonMatches(db, outlineId, pass.lessons.map(l => l.id), pass.candidates, { ...meta, scopeKps: new Set(kps.map(k => k.code)), sigs: new Map(kps.map(k => [k.code, k.sig])) })
}
