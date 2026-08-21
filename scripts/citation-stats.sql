-- ============================================================================
-- 巡检回答引用源统计（GEO 采信源分析）
-- 用途：统计 real_collect_record.raw_content 中 AI 回答引用的 URL 域名分布，
--       验证"12 自媒体平台作为 GEO 发布渠道是否有效"。
-- 用法（云服务器上执行）：
--   cd /opt/jlyl-cloud && docker compose exec -T db psql -U jlyl -d jlyl_cloud < scripts/citation-stats.sql
-- 时间窗口：默认近 30 天，修改下方 interval '30 days' 可调整。
-- ============================================================================

\timing off
\pset footer off

-- ============ 公共 CTE：提取 URL 域名 + 归一化 + 排除噪声 + 分类 ============
-- 噪声排除清单：AI 平台自身域名/分享链接、图片与静态资源 CDN、规范类站点
WITH urls AS (
  SELECT r.platform,
         r.brand_matched,
         lower((regexp_matches(r.raw_content, 'https?://([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', 'g'))[1]) AS domain
  FROM real_collect_record r
  WHERE r.raw_content IS NOT NULL
    AND r.query_time > now() - interval '30 days'
    AND length(r.raw_content) > 200
),
norm AS (
  SELECT platform, brand_matched,
         regexp_replace(domain, '^www\.', '') AS domain
  FROM urls
  WHERE domain NOT IN (
    -- AI 平台自身 / 分享链接
    'kimi.com', 'moonshot.cn',
    'yuanbao.tencent.com',
    'doubao.com', 'byteimg.com', 'ibyteimg.com', 'volces.com', 'bytedance.com',
    'chatglm.cn', 'zhipuai.cn', 'bigmodel.cn',
    'qianwen.com', 'tongyi.aliyun.com',
    'deepseek.com',
    'n.cn',
    'yiyan.baidu.com', 'chat.baidu.com', 'mr.baidu.com',
    -- 静态资源 / CDN / 规范类噪声
    'bdstatic.com', 'bdimg.com', 'bcebos.com', 'hbimg.cn',
    'gstatic.com', 'googleapis.com', 'schema.org', 'w3.org',
    'alicdn.com', 'aliyuncs.com', 'myqcloud.com', 'clouddn.com'
  )
),
classified AS (
  SELECT platform, brand_matched, domain,
    CASE
      WHEN domain IN ('mp.weixin.qq.com', 'weixin.qq.com', 'news.qq.com', 'new.qq.com', 'om.qq.com')
        THEN '腾讯系(公众号/企鹅号/腾讯新闻)'
      WHEN domain IN ('toutiao.com', 'm.toutiao.com') THEN '头条号'
      WHEN domain = 'baijiahao.baidu.com' THEN '百家号'
      WHEN domain IN ('douyin.com', 'iesdouyin.com') THEN '抖音'
      WHEN domain IN ('xiaohongshu.com', 'xhslink.com') THEN '小红书'
      WHEN domain IN ('zhihu.com', 'zhuanlan.zhihu.com') THEN '知乎'
      WHEN domain IN ('163.com', 'm.163.com') THEN '网易号/网易'
      WHEN domain IN ('sohu.com', 'm.sohu.com') THEN '搜狐号/搜狐'
      WHEN domain = 'jianshu.com' THEN '简书'
      WHEN domain IN ('csdn.net', 'blog.csdn.net') THEN 'CSDN'
      WHEN domain IN ('bilibili.com', 'b23.tv', 'space.bilibili.com') THEN '哔哩哔哩'
      ELSE NULL
    END AS self_media,
    CASE
      WHEN domain IN ('baike.baidu.com', 'zhidao.baidu.com', 'tieba.baidu.com', 'wenku.baidu.com', 'jingyan.baidu.com')
        THEN '百度系内容(百科/知道/贴吧/文库)'
      WHEN domain IN ('51cto.com', 'segmentfault.com', 'cnblogs.com', 'juejin.cn', 'oschina.net', 'iteye.com')
        THEN '技术社区'
      WHEN domain IN ('weibo.com', 'm.weibo.cn') THEN '微博'
      ELSE NULL
    END AS other_community
  FROM norm
),
final AS (
  SELECT platform, brand_matched, domain,
    COALESCE(self_media, other_community, '其他网站') AS source_name,
    CASE WHEN self_media IS NOT NULL THEN '系统12自媒体平台'
         WHEN other_community IS NOT NULL THEN '其他社区/问答'
         ELSE '其他网站' END AS source_type
  FROM classified
)

-- ============ 1. 总览 ============
\echo ''
\echo '===== 1. 总览（近30天）====='
SELECT
  (SELECT count(*) FROM real_collect_record
    WHERE query_time > now() - interval '30 days' AND length(raw_content) > 200) AS 记录总数,
  (SELECT count(DISTINCT platform) FROM final) AS 出现引用的平台数,
  (SELECT count(*) FROM final) AS 引用URL总数,
  (SELECT count(DISTINCT domain) FROM final) AS 去重域名数;

-- ============ 2. 引用源大类占比 ============
\echo ''
\echo '===== 2. 引用源大类占比（回答"自媒体平台还有没有用"）====='
SELECT source_type AS 引用源大类,
       count(*) AS 引用次数,
       round(100.0 * count(*) / sum(count(*)) over (), 1) || '%' AS 占比,
       count(DISTINCT domain) AS 域名数
FROM final
GROUP BY source_type
ORDER BY count(*) DESC;

-- ============ 3. 细分渠道排行（含自媒体/社区具体渠道）===========
\echo ''
\echo '===== 3. 细分渠道排行 TOP 30 ====='
SELECT source_name AS 渠道,
       count(*) AS 引用次数,
       round(100.0 * count(*) / sum(count(*)) over (), 1) || '%' AS 占比,
       count(DISTINCT platform) AS 被几个AI引用
FROM final
GROUP BY source_name
ORDER BY count(*) DESC
LIMIT 30;

-- ============ 4. 各 AI 平台 × 引用源大类交叉 ============
\echo ''
\echo '===== 4. 各 AI 平台的引用源偏好（交叉统计）====='
SELECT platform AS AI平台,
       source_type AS 引用源大类,
       count(*) AS 引用次数
FROM final
GROUP BY platform, source_type
ORDER BY platform, count(*) DESC;

-- ============ 5. 域名总榜 TOP 50 ============
\echo ''
\echo '===== 5. 被引用域名总榜 TOP 50 ====='
SELECT domain AS 域名,
       count(*) AS 引用次数,
       string_agg(DISTINCT platform, '、') AS 引用它的AI
FROM final
GROUP BY domain
ORDER BY count(*) DESC
LIMIT 50;

-- ============ 6. 每个 AI 平台各自 TOP 10 引用域名 ============
\echo ''
\echo '===== 6. 每个 AI 平台 TOP 10 引用域名 ====='
SELECT platform AS AI平台, 引用次数, 域名
FROM (
  SELECT platform, domain, count(*) AS 引用次数,
         row_number() OVER (PARTITION BY platform ORDER BY count(*) DESC) AS rn
  FROM final
  GROUP BY platform, domain
) t
WHERE rn <= 10
ORDER BY platform, 引用次数 DESC;

-- ============ 7. 品牌命中 vs 未命中：引用源差异 ============
\echo ''
\echo '===== 7. 品牌命中 vs 未命中记录的引用源差异 ====='
SELECT CASE WHEN brand_matched THEN '品牌命中' ELSE '未命中' END AS 记录类型,
       source_type AS 引用源大类,
       count(*) AS 引用次数
FROM final
GROUP BY 1, source_type
ORDER BY 1 DESC, count(*) DESC;

\echo ''
\echo '===== 完成。建议关注：第2节自媒体占比、第4节各AI偏好、第7节命中/未命中差异 ====='
