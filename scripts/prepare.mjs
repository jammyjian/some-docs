// 构建前预处理：把中文/带空格目录名与文件名的 Markdown 复制到 .vitepress/src/，
// 路径每一段统一转成拼音 slug。侧边栏标题与「最后更新」登记在 url-map.json，由 config.mts 读取。
// 正文里的链接也做改写：绝对源路由（/目录/中文名）和同目录相对链接（中文文件名）统一指向 slug 路由。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pinyin } from 'pinyin-pro'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'docs')
const OUT = path.join(SRC, '.vitepress', 'src')
const MAP_PATH = path.join(SRC, '.vitepress', 'url-map.json')

const toPosix = (p) => p.split(path.sep).join('/')

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(abs))
    else if (entry.name.endsWith('.md')) files.push(abs)
  }
  return files
}

function slugify(base) {
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(base)) return base.toLowerCase()
  const text = pinyin(base, { toneType: 'none', nonZh: 'consecutive' })
  return (
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join('-')
      .replace(/^-+|-+$/g, '') || 'page'
  )
}

// 目录路径逐段转 slug：
// "01-Chapter 1-安全生产法律法规" -> "01-chapter-1-an-quan-sheng-chan-fa-l-fa-gui"
function slugifyDir(relDir) {
  if (relDir === '.' || relDir === '') return ''
  return relDir.split('/').map((seg) => slugify(seg)).join('/')
}

// 源目录 -> 对外路由前缀（不参与拼音化）。
// 源目录改名后，在这里钉死旧路由，已发布的 URL 就不会变；新增目录不必登记。
const DIR_ROUTE_OVERRIDES = {
  '电工知识': 'electrician',
  '电工知识/《低压电工考证学习文档》': 'electrician/low-voltage-electrician',
  '电工知识/《低压电工考证学习文档》/14-Chapter 14-实操考核': 'electrician/low-voltage-electrician/14-chapter-14-shi-cao-kao-he-yu-ying-shi-ji-qiao',
}

// 取最深的匹配前缀，剩余层级仍走拼音：
// "电工知识/《低压电工考证学习文档》/01-Chapter 1-..." -> "electrician/low-voltage-electrician/01-chapter-1-..."
function routeDir(relDir) {
  if (relDir === '.' || relDir === '') return ''
  let best = ''
  for (const src of Object.keys(DIR_ROUTE_OVERRIDES)) {
    if ((relDir === src || relDir.startsWith(`${src}/`)) && src.length > best.length) best = src
  }
  if (!best) return slugifyDir(relDir)
  const rest = relDir.slice(best.length).replace(/^\//, '')
  return rest ? `${DIR_ROUTE_OVERRIDES[best]}/${slugifyDir(rest)}` : DIR_ROUTE_OVERRIDES[best]
}

function gitTime(abs) {
  try {
    // --follow 让文件在目录改名后仍沿用原有的提交历史
    const out = execFileSync('git', ['log', '-1', '--follow', '--format=%at', '--', abs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return out ? Number(out) : undefined
  } catch {
    return undefined
  }
}

export function prepare() {
  const files = walk(SRC)
  const oldMap = fs.existsSync(MAP_PATH)
    ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))
    : {}
  const newMap = {}
  const used = new Set()

  // 第一遍：计算 slug/route，把原文写入生成树
  for (const abs of files) {
    const rel = toPosix(path.relative(SRC, abs))
    const relDir = path.posix.dirname(rel)
    const genDir = routeDir(relDir)
    const filename = path.basename(rel)

    let slug
    if (oldMap[rel]?.slug) {
      slug = oldMap[rel].slug // 已登记过的文件复用 slug，保持 URL 稳定
    } else {
      slug = slugify(filename.replace(/\.md$/, ''))
      let candidate = slug
      let i = 2
      while (used.has(`${genDir}/${candidate}`)) candidate = `${slug}-${i++}`
      slug = candidate
    }
    used.add(`${genDir}/${slug}`)

    const content = fs.readFileSync(abs, 'utf8')
    const title = (content.match(/^#\s+(.+)$/m) || [])[1]?.trim() || filename
    // VitePress 的 lastUpdated 使用毫秒时间戳；git log 返回秒，需换算
    const t = gitTime(abs)
    // git 查不到历史（如目录刚改名、尚未提交）时沿用上次登记的时间，避免整站时间变成今天
    const lastUpdated = t ? t * 1000 : (oldMap[rel]?.lastUpdated ?? Math.floor(fs.statSync(abs).mtimeMs))

    // route = 生成后的相对路径（不含 .md），如 "any/chong-qing-opc-she-qu-diao-yan"
    const route = genDir ? `${genDir}/${slug}` : slug
    const outAbs = path.join(OUT, `${route}.md`)
    fs.mkdirSync(path.dirname(outAbs), { recursive: true })
    fs.writeFileSync(outAbs, content)

    newMap[rel] = { slug, route, title, lastUpdated }
  }

  // 把源路径写法的链接（首页按钮、正文里的绝对/相对引用）统一改成 slug 路由
  const rewriteLinks = (content, srcDir) => {
    // 1) 绝对源路由：/<dir>/<base>.md 或 /<dir>/<base> -> /<route>
    for (const [key, v] of Object.entries(newMap)) {
      if (key === 'index.md') continue
      const dir = path.posix.dirname(key)
      const base = path.posix.basename(key, '.md')
      const prefix = dir === '.' ? '' : `/${dir}`
      for (const form of [`${prefix}/${base}.md`, `${prefix}/${base}`]) {
        content = content.split(form).join(`/${v.route}`)
      }
    }
    // 2) 相对链接（同目录文件名或子目录路径，可能 URL 编码），解析到源文件后换成绝对 slug 路由
    content = content.replace(/\]\(([^)]+)\)/g, (full, dest) => {
      const [pathPart, ...rest] = dest.split('#')
      const hash = rest.length ? '#' + rest.join('#') : ''
      let clean = pathPart.trim()
      if (clean.startsWith('/')) return full // 绝对路径已由第 1 步处理
      let decoded = clean
      try {
        decoded = decodeURI(clean)
      } catch {
        /* 非法编码时保持原样 */
      }
      if (decoded.startsWith('./')) decoded = decoded.slice(2)
      if (decoded === '') return full
      const noExt = decoded.replace(/\.md$/, '')
      // 归一化 ../ 与 ./，否则跨章节的相对链接匹配不到 newMap 的 key
      const candidate = path.posix.normalize(srcDir === '.' ? noExt : `${srcDir}/${noExt}`)
      const route = newMap[`${candidate}.md`]?.route
      if (!route) return full
      return full.replace(dest, `/${route}${hash}`)
    })
    return content
  }

  // 第二遍：对所有生成文件统一做链接改写
  for (const [key, v] of Object.entries(newMap)) {
    const abs = path.join(OUT, `${v.route}.md`)
    if (!fs.existsSync(abs)) continue
    const content = fs.readFileSync(abs, 'utf8')
    fs.writeFileSync(abs, rewriteLinks(content, path.posix.dirname(key)))
  }

  // 清理已不存在的源文件对应的生成文件
  const valid = new Set(Object.values(newMap).map((v) => toPosix(path.join(OUT, `${v.route}.md`))))
  for (const abs of walk(OUT)) {
    if (!valid.has(abs)) fs.rmSync(abs, { force: true })
  }
  for (const entry of fs.readdirSync(OUT, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const abs = path.join(OUT, entry.name)
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
    }
  }

  fs.writeFileSync(MAP_PATH, JSON.stringify(newMap, null, 2) + '\n')
}

// 直接运行脚本时执行一次（被 dev.mjs 以模块方式引入时跳过）
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  prepare()
  console.log('[prepare] 预处理完成，产物见 docs/.vitepress/src/')
}
