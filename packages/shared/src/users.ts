import type { PersonRef } from './task.js'

/**
 * 用户目录（演示环境静态目录，对应文档角色模型：附录 B）
 * 真实部署替换为 IAM/SSO。前端「当前身份」切换器用于体验不同拍板人视角。
 */

export interface User {
  userId: string
  name: string
  role: string
  tags: string[]
}

export const USERS: User[] = [
  { userId: 'zhangming', name: '张明', role: '需求方 PO', tags: ['事实门拍板'] },
  { userId: 'wanghao', name: '王浩', role: '开发（责任人）', tags: ['唯一推进者', '测试门拍板'] },
  { userId: 'liwan', name: '李婉', role: '设计师', tags: ['设计主笔'] },
  { userId: 'chenshu', name: '陈枢', role: '架构师', tags: ['架构门拍板'] },
  { userId: 'wuqian', name: '吴倩', role: 'TSE（测试设计）', tags: ['测试设计门拍板', '聚合验收拍板'] },
  { userId: 'zhaolei', name: '赵磊', role: '评审人', tags: ['评审门拍板'] },
  { userId: 'sunlin', name: '孙琳', role: '安全组', tags: ['会诊'] },
  { userId: 'zhoujie', name: '周杰', role: '合入方', tags: ['交付门拍板（永远人工）'] },
  { userId: 'liuyang', name: '刘阳', role: '开发', tags: ['AR 并行承接'] },
  { userId: 'chenjing', name: '陈静', role: '开发', tags: ['AR 并行承接'] },
  { userId: 'xulei', name: '徐磊', role: '开发', tags: ['AR 并行承接'] },
  { userId: 'admin', name: '管理员', role: '平台管理员', tags: ['可代拍板（留痕）'] },
]

export function findUser(userId: string): User | undefined {
  return USERS.find((u) => u.userId === userId)
}

export function personOf(userId: string, fallbackRole = '开发'): PersonRef {
  const u = findUser(userId)
  return { userId, name: u?.name ?? userId, role: u?.role ?? fallbackRole }
}
