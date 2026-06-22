'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Spin, Pagination, Radio, Select, Row, Col, Flex, Button, Modal, message, Form, Input } from 'antd';
import ReactECharts from 'echarts-for-react';
import api from '@/lib/api';
import { useRouter } from 'next/navigation';
import styles from './dashboard.module.css';

const IMG = 'https://static.7asi.com/assets/reportGeo';

// 平台图标映射（与 7asi 参考页一致；智谱AI 使用品牌色蓝色背景+白色Z字母logo）
const PLATFORM_ICONS: Record<string, string> = {
  '豆包': 'https://static.7asi.com/assets/GeoYy/Frame%20(2).png',
  '文心一言': 'https://static.7asi.com/assets/GeoYy/Frame%20(3).png',
  'DeepSeek': 'https://static.7asi.com/assets/GeoYy/Vector.png',
  'Kimi': 'https://static.7asi.com/assets/GeoYy/Frame.png',
  '腾讯元宝': 'https://static.7asi.com/assets/GeoYy/Frame%20(4).png',
  '通义千问': 'https://static.7asi.com/assets/GeoYy/Frame%20(1).png',
  '百度AI': 'https://static.7asi.com/assets/GeoYy/baiduai.png',
  '纳米': 'https://static.7asi.com/assets/GeoYy/nm.png',
  '智谱AI': "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='40'%20height='40'%20viewBox='0%200%2040%2040'%3E%3Crect%20width='40'%20height='40'%20rx='8'%20fill='%233B5BFF'/%3E%3Cpath%20d='M28%2012H14L19%2019L14%2026H28'%20stroke='white'%20stroke-width='3.5'%20stroke-linecap='round'%20stroke-linejoin='round'%20fill='none'/%3E%3C/svg%3E",
};

interface StatsData {
  total: number;
  count: number;
  zlgjc: number;
  ppgjc: number;
}

interface PlatformRatioItem {
  platform: string;
  count: number;
}

interface KeywordCountItem {
  distillateKeyword: string;
  count: number;
}

interface SearchRankItem {
  id: number;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  queryTime: string;
  url: string;
  zlgjcUrl?: string;
}

interface LoginUser {
  id: string;
  username: string;
  phone: string;
  email: string;
  url: string;
  dateTime: string;
  password?: string;
  address?: string;
  level?: string;
  cid?: string;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

// AI名片组件
function AICard({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [user, setUser] = useState<LoginUser>({ id: '-1', username: '', phone: '-', url: '', email: '-', password: '', address: '', level: '', cid: '', dateTime: '' });

  useEffect(() => {
    if (!userId) {
      setUser({ id: '-1', username: '', phone: '-', url: '', email: '-', password: '', address: '', level: '', cid: '', dateTime: '' });
      return;
    }
    (async () => {
      const res = await api.get('/users/getLoginUser', { params: { userId } });
      if (res.data?.code === 200) {
        const d = res.data.data;
        let phone = d.phone ? String(d.phone) : '-';
        if (Number(phone) === Number(d.phone)) {
          phone = phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
        }
        setUser({ ...d, phone: d.phone ? phone : '-', email: d.email ? d.email : '-' });
      }
    })();
  }, [userId]);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.aiCardHeader} ${isMobile ? styles.aiMobile : styles.aiPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Profile.png`} alt="" />
          </div>
          <div className={styles.aiTitle}>{user.username}</div>
        </div>
      }
      className={`${styles.gCard} ${styles.aiWrapper} ${isMobile ? styles.aiMobile : styles.aiPc}`}
    >
      {isMobile ? (
        <Row className={styles.aiBaseInfo}>
          <Col className={styles.aiLeft} span={8}>
            <div className={styles.aiFWrapper}>
              <div className={styles.aiFIcon}>
                <img src={`${IMG}/256x256.png`} alt="" />
              </div>
              <div className={styles.aiFTitle}>AI名片</div>
            </div>
          </Col>
          <Col className={styles.aiRight} span={16}>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235607.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>电话:{user.phone}</div>
            </div>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235605.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>邮箱:{user.email && user.email !== '-' ? user.email : ''}</div>
            </div>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235606.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>网址:{user.url ? <a href={user.url} target="_blank">{user.url}</a> : ''}</div>
            </div>
          </Col>
        </Row>
      ) : (
        <Row className={styles.aiBaseInfo}>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiFIcon}>
                  <img src={`${IMG}/256x256.png`} alt="" />
                </div>
                <div className={styles.aiFTitle}>AI名片</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235607.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>电话</div>
                <div className={styles.aiItemContent}>{user.phone}</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235605.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>邮箱</div>
                <div className={styles.aiItemContent}>{user.email}</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235606.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>网址</div>
                <div className={styles.aiItemContent}>{user.url ? <a href={user.url} target="_blank">{user.url}</a> : '-'}</div>
              </div>
            </Flex>
          </Col>
        </Row>
      )}
    </Card>
  );
}

// 各平台收录对比组件
function PlatformRatioChart({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [option, setOption] = useState({});
  const [chartData, setChartData] = useState<Array<{ name: string; count: number; color: string }>>([]);

  useEffect(() => {
    if (!userId) {
      setOption({});
      setChartData([]);
      return;
    }
    (async () => {
      const res = await api.get('/keywordsearchrank/platformRatio', { params: { userId } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        if (!data || data.length === 0) {
          setOption({});
          setChartData([]);
          return;
        }
        const colors = ['#ffb3a7', '#ff9f91', '#ff8a7a', '#ff7563', '#ff6150', '#ff4c3c', '#ff3727', '#ff4c3c', '#ff7563'];
        const formatted = data.map((e: PlatformRatioItem, i: number) => ({
          id: i + 1,
          name: e.platform,
          count: e.count,
          color: colors[i % colors.length],
        }));
        setChartData(formatted);
        // PC端和移动端都不使用ECharts内置图例，改用自定义HTML图例（带平台图标）
        setOption({
          tooltip: { trigger: 'item' },
          legend: { show: false },
          series: [
            {
              name: '占比',
              type: 'pie',
              radius: ['45%', '70%'],
              label: { show: false },
              data: formatted.map((e: { count: number; name: string; color: string }) => ({
                value: e.count,
                name: e.name,
                itemStyle: { color: e.color },
              })),
              ...(isMobile ? { center: ['50%', '45%'] } : { center: ['50%', '50%'] }),
            },
            {
              type: 'pie',
              radius: ['0%', '35%'],
              silent: true,
              label: { show: false },
              itemStyle: { color: 'transparent' },
              data: [{ value: 1 }],
              ...(isMobile ? { center: ['50%', '45%'] } : { center: ['50%', '50%'] }),
            },
          ],
        });
      }
    })();
  }, [isMobile, userId]);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.prCardHeader} ${isMobile ? styles.prMobile : styles.prPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Graph.png`} alt="" />
          </div>
          <div className={styles.prTitle}>各平台收录占比</div>
        </div>
      }
      className={`${styles.gCard} ${styles.prWrapper} ${isMobile ? styles.prMobile : styles.prPc}`}
    >
      <div className={isMobile ? styles.prMobileChartWrapper : styles.prPcChartWrapper}>
        <ReactECharts option={option} style={{ height: isMobile ? 240 : 400, width: '100%' }} opts={{ renderer: 'canvas' }} />
        {chartData.length > 0 && (
          <div className={isMobile ? styles.prMobileLegend : styles.prPcLegend}>
            {chartData.map((e) => (
              <div key={e.name} className={styles.prLegendItem}>
                <span className={styles.prLegendColor} style={{ background: e.color }} />
                <img src={PLATFORM_ICONS[e.name] || ''} alt="" className={styles.prLegendIcon} />
                <span className={styles.prLegendName}>{e.name}</span>
                <span className={styles.prLegendCount}>{e.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// 蒸馏关键词排名组件
function KeywordRankChart({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [list, setList] = useState<KeywordCountItem[]>([]);

  useEffect(() => {
    if (!userId) {
      setList([]);
      return;
    }
    (async () => {
      const res = await api.get('/keywordsearchrank/keywordcound', { params: { userId } });
      if (res.data?.code === 200) {
        setList(res.data.data || []);
      }
    })();
  }, [userId]);

  const maxCount = Math.max(...list.map((e) => e.count), 1);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.krCardHeader} ${isMobile ? styles.krMobile : styles.krPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Activity.png`} alt="" />
          </div>
          <div className={styles.krTitle}>核心关键词热度排名</div>
        </div>
      }
      className={`${styles.gCard} ${styles.krWrapper} ${isMobile ? styles.krMobile : styles.krPc}`}
    >
      <div className={styles.krContentWrapper}>
        {list.map((e) => (
          <div key={e.distillateKeyword} className={styles.krItem}>
            <div className={styles.krName}>{e.distillateKeyword}</div>
            <div className={styles.krBarWrapper}>
              <div
                className={styles.krBar}
                style={{ width: `${Math.max((e.count / maxCount) * 100, 2)}%` }}
              />
            </div>
            <div className={styles.krCount}>{e.count}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// 关键词数量组件
function KeywordStats({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [stats, setStats] = useState<StatsData>({ count: 0, zlgjc: 0, ppgjc: 0, total: 0 });

  useEffect(() => {
    if (!userId) {
      setStats({ count: 0, zlgjc: 0, ppgjc: 0, total: 0 });
      return;
    }
    (async () => {
      const res = await api.get('/dstillateKeyword/countDstillateKeyword', { params: { userId } });
      if (res.data?.code === 200) {
        setStats(res.data.data);
      }
    })();
  }, [userId]);

  const items = [
    { icon: 'Iconly_Glass_Clock.png', title: '核心关键词', count: stats.count },
    { icon: 'Gallery.png', title: '蒸馏关键词', count: stats.zlgjc },
    { icon: 'Gallery (1).png', title: '品牌关键词', count: stats.ppgjc },
    { icon: 'Iconly_Glass_Document.png', title: '总收录条数', count: stats.total },
  ];

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.ksCardHeader} ${isMobile ? styles.ksMobile : styles.ksPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Discovery.png`} alt="" />
          </div>
          <div className={styles.ksTitle}>关键词数量</div>
        </div>
      }
      className={`${styles.gCard} ${styles.ksWrapper} ${isMobile ? styles.ksMobile : styles.ksPc}`}
    >
      {isMobile ? (
        <div className={styles.ksItemsWrapper}>
          {items.map((item) => (
            <div key={item.title} className={styles.ksItemWrapper}>
              <div className={styles.ksIcon}>
                <img src={`${IMG}/${encodeURIComponent(item.icon)}`} alt="" />
              </div>
              <div className={styles.ksContentWrapper}>
                <div className={styles.ksTitle2}>{item.title}</div>
                <div className={styles.ksCount}>{item.count}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Row className={styles.ksContentWrapper}>
          {items.map((item, idx) => (
            <Col key={item.title} span={6}>
              <div className={styles.ksItemWrapper}>
                <div className={styles.ksIcon}>
                  <img src={`${IMG}/${encodeURIComponent(item.icon)}`} alt="" />
                </div>
                <div className={styles.ksContentWrapper2}>
                  <div className={styles.ksTitle2}>{item.title}</div>
                  <div className={styles.ksCount}>{item.count}</div>
                </div>
                {idx < items.length - 1 && <div className={styles.ksSplitLine} />}
              </div>
            </Col>
          ))}
        </Row>
      )}
    </Card>
  );
}

// 搜索排名组件
function SearchRank({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [searchType, setSearchType] = useState('keywords');
  const [platforms, setPlatforms] = useState<PlatformRatioItem[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformRatioItem | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState({ current: 1, pageSize: 10 });
  const [total, setTotal] = useState(0);
  const [keywordOptions, setKeywordOptions] = useState<KeywordCountItem[]>([]);
  const [list, setList] = useState<SearchRankItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async (type: string, pt?: string, kw?: string, pageNum = 1, pageSize = 10) => {
    if (!userId) {
      setList([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    try {
      const params: Record<string, string> = { type, pageNum: String(pageNum), pageSize: String(pageSize), userId };
      if (pt) params.pt = pt;
      if (kw) params.keyword = kw;
      const res = await api.get('/keywordsearchrank/keypage', { params });
      if (res.data?.code === 200) {
        setList(res.data.data?.list || []);
        setTotal(res.data.data?.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const init = useCallback(async () => {
    if (!userId) {
      setPlatforms([]);
      setActivePlatform(undefined);
      setKeywordOptions([]);
      setList([]);
      setTotal(0);
      return;
    }
    const params: Record<string, string> = { userId };
    const res = await api.get('/keywordsearchrank/platformRatio', { params: { ...params, type: searchType } });
    if (res.data?.code === 200) {
      setPlatforms(res.data.data || []);
      setActivePlatform(res.data.data?.[0]);
      fetchData(searchType, res.data.data?.[0]?.platform, keyword, 1, page.pageSize);
    }
    const res2 = await api.get('/keywordsearchrank/keywordcound', { params });
    if (res2.data?.code === 200) {
      setKeywordOptions([{ distillateKeyword: '', count: 0 }, ...(res2.data.data || [])]);
    }
  }, [userId, fetchData, searchType, keyword, page.pageSize]);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleSearchTypeChange = async (v: string) => {
    setSearchType(v);
    setPage({ current: 1, pageSize: page.pageSize });
    // 重新获取平台数量（按类型过滤）
    if (userId) {
      try {
        const res = await api.get('/keywordsearchrank/platformRatio', { params: { userId, type: v } });
        if (res.data?.code === 200) {
          const newPlatforms = res.data.data || [];
          setPlatforms(newPlatforms);
          // 保持当前选中平台，如果新列表中没有则选第一个
          const stillExists = newPlatforms.find((p: PlatformRatioItem) => p.platform === activePlatform?.platform);
          const newActive = stillExists || newPlatforms[0];
          setActivePlatform(newActive);
          fetchData(v, newActive?.platform, keyword, 1, page.pageSize);
          return;
        }
      } catch {
        // 忽略错误，降级为不更新平台数量
      }
    }
    fetchData(v, activePlatform?.platform, keyword, 1, page.pageSize);
  };

  const handlePlatformChange = (p: PlatformRatioItem) => {
    setActivePlatform(p);
    setPage({ current: 1, pageSize: page.pageSize });
    fetchData(searchType, p.platform, keyword, 1, page.pageSize);
  };

  const handleKeywordChange = (k: string) => {
    setKeyword(k);
    setPage({ current: 1, pageSize: page.pageSize });
    fetchData(searchType, activePlatform?.platform, k, 1, page.pageSize);
  };

  const handlePageChange = (current: number, pageSize: number) => {
    setPage({ current, pageSize });
    fetchData(searchType, activePlatform?.platform, keyword, current, pageSize);
  };

  const columns = [
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', key: 'distillateKeyword' },
    { title: '核心关键词', dataIndex: 'expandedKeyword', key: 'expandedKeyword' },
    { title: '平台', align: 'center' as const, dataIndex: 'platform', key: 'platform' },
    {
      title: '查询时间',
      align: 'center' as const,
      dataIndex: 'queryTime',
      key: 'queryTime',
      render: (e: string) => (e ? new Date(e).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e),
    },
    {
      title: '查看详情',
      align: 'center' as const,
      key: 'zlgjcUrl',
      dataIndex: 'zlgjcUrl',
      render: (e: string) =>
        e ? (
          <a href={e} target="_blank" rel="noopener noreferrer" className={styles.srDetailLink}>
            跳 转
          </a>
        ) : null,
    },
  ];

  const mobileColumns = [
    { title: '核心关键词', dataIndex: 'expandedKeyword', key: 'expandedKeyword', width: 90 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', key: 'distillateKeyword', width: 100 },
    { title: '平台', align: 'center' as const, dataIndex: 'platform', key: 'platform', width: 70 },
    {
      title: '查询时间',
      align: 'center' as const,
      dataIndex: 'queryTime',
      key: 'queryTime',
      width: 70,
      render: (e: string) => (e ? new Date(e).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e),
    },
    {
      title: '查看详情',
      align: 'center' as const,
      key: 'zlgjcUrl',
      dataIndex: 'zlgjcUrl',
      width: 70,
      render: (e: string) =>
        e ? (
          <a href={e} target="_blank" rel="noopener noreferrer" className={styles.srDetailLink}>
            跳转
          </a>
        ) : null,
    },
  ];

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.srCardHeader} ${isMobile ? styles.srMobile : styles.srPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Chart.png`} alt="" />
          </div>
          <div className={styles.srTitle}>搜索详情</div>
        </div>
      }
      className={`${styles.gCard} ${styles.srWrapper} ${isMobile ? styles.srMobile : styles.srPc}`}
    >
      <div className={styles.srBtnsWrapper}>
        <div className={styles.srBtns}>
          <Radio.Group
            value={searchType}
            onChange={(e) => handleSearchTypeChange(e.target.value)}
            buttonStyle="solid"
            className={styles.srBtnWrapper}
          >
            <Radio.Button value="keywords" className={styles.srBtn}>关键词搜索</Radio.Button>
            <Radio.Button value="brand" className={styles.srBtn}>品牌搜索</Radio.Button>
            <Radio.Button value="scene" className={styles.srBtn}>联系方式</Radio.Button>
          </Radio.Group>
        </div>
      </div>
      <div className={styles.srTabsWrapper}>
        <div className={styles.srTabs}>
          {platforms.map((e) => (
            <Tag.CheckableTag
              key={e.platform}
              checked={activePlatform?.platform === e.platform}
              className={`${styles.srTab} ${activePlatform?.platform === e.platform ? styles.srChecked : ''}`}
              onClick={() => handlePlatformChange(e)}
            >
              <div className={styles.srPlatformItem}>
                <span>{e.platform}</span>
                <span>({e.count})</span>
              </div>
            </Tag.CheckableTag>
          ))}
        </div>
        {isMobile ? (
          <div className={styles.srSelectWrapper}>
            <Select
              value={keyword}
              popupMatchSelectWidth={false}
              onChange={handleKeywordChange}
              options={keywordOptions.map((e) => ({
                value: e.distillateKeyword,
                label: e.distillateKeyword === '' ? '全部' : `${e.distillateKeyword}(${e.count})`,
              }))}
            />
          </div>
        ) : (
          <div className={styles.srSelectWrapper}>
            <Select
              value={keyword}
              style={{ width: 120 }}
              popupMatchSelectWidth={false}
              onChange={handleKeywordChange}
              options={keywordOptions.map((e) => ({
                value: e.distillateKeyword,
                label: e.distillateKeyword === '' ? '全部' : `${e.distillateKeyword}(${e.count})`,
              }))}
            />
          </div>
        )}
      </div>
      <div className={styles.srList}>
        {isMobile ? (
          <div className={styles.srTableWrapperMobile}>
            <Table
              columns={mobileColumns}
              className={`${styles.srTable} ${styles.srMobileTable}`}
              dataSource={list}
              pagination={false}
              loading={loading}
              rowKey="id"
              size="small"
              scroll={{ x: 400 }}
            />
          </div>
        ) : (
          <div className={styles.srTableWrapper}>
            <Table
              columns={columns}
              className={styles.srTable}
              dataSource={list}
              pagination={false}
              loading={loading}
              rowKey="id"
              size="small"
            />
          </div>
        )}
        <div className={styles.srPageWrapper}>
          <Pagination
            current={page.current}
            pageSize={page.pageSize}
            total={total}
            align="center"
            showSizeChanger={false}
            size={isMobile ? 'small' : undefined}
            onChange={handlePageChange}
          />
        </div>
      </div>
    </Card>
  );
}

// 主页面
export default function DashboardPage() {
  const router = useRouter();
  // 响应式：参考 7asi.com 的手机端效果，小视口下使用单列垂直布局
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const [loading, setLoading] = useState(true);
  const [gLoadingText, setGLoadingText] = useState('聚量引力GEO');
  const [user, setUser] = useState<LoginUser>({ id: '-1', username: '', phone: '', url: '', email: '', password: '', address: '', level: '', cid: '', dateTime: '' });
  const [lastUpdate, setLastUpdate] = useState('');
  const [currentTime, setCurrentTime] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  // 是否为管理员（只有管理员才能切换用户）
  const [isAdmin, setIsAdmin] = useState(false);
  // 分享功能相关状态
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareCustomTitle, setShareCustomTitle] = useState('');
  const [shareTokens, setShareTokens] = useState<Array<{ token: string; createTime: string; lastUseTime: string | null }>>([]);
  // 云端配置状态
  const [cloudConfigError, setCloudConfigError] = useState<string>('');
  const [cloudConfigVisible, setCloudConfigVisible] = useState(false);
  const [cloudConfigForm, setCloudConfigForm] = useState({ cloudUrl: '', adminUsername: '', adminPassword: '' });
  const [cloudConfigLoading, setCloudConfigLoading] = useState(false);

  // 保存云端配置
  const handleSaveCloudConfig = async () => {
    if (!cloudConfigForm.cloudUrl || !cloudConfigForm.adminUsername || !cloudConfigForm.adminPassword) {
      return;
    }
    setCloudConfigLoading(true);
    try {
      const res = await api.post('/users/login', {
        username: cloudConfigForm.adminUsername,
        password: cloudConfigForm.adminPassword,
        cloudUrl: cloudConfigForm.cloudUrl,
      });
      if (res.data?.code === 200) {
        setCloudConfigError('');
        setCloudConfigVisible(false);
        // 重新加载页面
        window.location.reload();
      } else {
        setCloudConfigError(res.data?.message || '配置失败，请检查云端地址和凭据');
      }
    } catch {
      setCloudConfigError('配置失败，请检查网络连接');
    } finally {
      setCloudConfigLoading(false);
    }
  };

  useEffect(() => {
    // 如果是通过分享链接进入，恢复自定义浏览器标题
    const shareCustomTitle = localStorage.getItem('shareCustomTitle');
    if (shareCustomTitle) {
      document.title = shareCustomTitle;
      setGLoadingText(shareCustomTitle);
    }
    const fetchUser = async () => {
      try {
        const res = await api.get('/users/getLoginUser');
        if (res.data?.code === 200) {
          const userData = res.data.data;
          setLastUpdate(userData.dateTime || '');
          setUser(userData);
          // 判断是否为管理员（level === '1'）
          const admin = userData.level === '1';
          setIsAdmin(admin);
          if (admin) {
            // 管理员：获取用户列表，默认选择第一个非 admin 用户
            try {
              const usersRes = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
              if (usersRes.data?.code === 200) {
                const allUsers = usersRes.data.data?.list || [];
                const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
                setUsers(userList);
                if (userList.length > 0) {
                  setSelectedUserId(String(userList[0].id));
                }
              }
            } catch {
              // 忽略错误
            }
          } else {
            // 普通用户：只能看自己的数据
            setSelectedUserId(String(userData.id));
          }
        } else if (res.data?.code === 401) {
          // 未登录，跳转到登录页
          router.push('/login');
        } else if (res.data?.code === 403) {
          // 云端未配置
          setCloudConfigError(res.data?.message || '未配置云端服务，请先配置云端连接');
        }
      } catch {
        // 忽略错误
      }
    };
    fetchUser();

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    setCurrentTime(`${y}年${m}月${d}日`);

    setTimeout(() => setLoading(false), 1000);
  }, [router]);

  // 切换用户时更新最后更新时间
  useEffect(() => {
    if (!selectedUserId) return;
    (async () => {
      try {
        const res = await api.get('/users/getLoginUser', { params: { userId: selectedUserId } });
        if (res.data?.code === 200) {
          setLastUpdate(res.data.data.dateTime || '');
        }
      } catch {
        // 忽略错误
      }
    })();
  }, [selectedUserId]);

  // 切换用户时更新header显示的用户名
  const displayUsername = selectedUserId
    ? users.find((u) => String(u.id) === String(selectedUserId))?.username || user.username
    : user.username;

  const onLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userInfo');
    localStorage.removeItem('shareLogin');
    router.push('/login');
  };

  // 生成分享链接
  const onGenerateShare = async () => {
    setShareLoading(true);
    try {
      // 管理员可为指定用户生成，普通用户为自己生成
      const body: Record<string, any> = {};
      if (isAdmin && selectedUserId) {
        body.userId = selectedUserId;
      }
      if (shareCustomTitle.trim()) {
        body.customTitle = shareCustomTitle.trim();
      }
      const res = await api.post('/users/generateShareToken', body);
      if (res.data?.code === 200 && res.data.data?.shareToken) {
        // 将用户名直接以中文形式加入分享链接（不使用encodeURIComponent，便于用户直观看到用户名）
        const username = res.data.data.username || '';
        const url = `${window.location.origin}/share/${res.data.data.shareToken}${username ? `?u=${username}` : ''}`;
        setShareUrl(url);
        message.success('分享链接生成成功');
        // 刷新分享链接列表
        loadShareTokens();
      } else {
        message.error(res.data?.message || '生成失败');
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '生成失败');
    } finally {
      setShareLoading(false);
    }
  };

  // 加载已有分享链接列表
  const loadShareTokens = async () => {
    try {
      const params: Record<string, string> = {};
      if (isAdmin && selectedUserId) {
        params.userId = selectedUserId;
      }
      const res = await api.get('/users/shareTokens', { params });
      if (res.data?.code === 200) {
        setShareTokens(res.data.data || []);
      }
    } catch {
      // 忽略
    }
  };

  // 删除分享链接
  const onDeleteShareToken = async (token: string) => {
    try {
      const res = await api.post('/users/deleteShareToken', { token });
      if (res.data?.code === 200) {
        message.success('删除成功');
        loadShareTokens();
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch {
      message.error('删除失败');
    }
  };

  // 复制到剪贴板
  const onCopyShareUrl = () => {
    if (!shareUrl) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        message.success('已复制到剪贴板');
      }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        message.success('已复制到剪贴板');
      });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      message.success('已复制到剪贴板');
    }
  };

  // 打开分享弹窗
  const onOpenShareModal = () => {
    setShareModalVisible(true);
    setShareUrl('');
    setShareCustomTitle('');
    loadShareTokens();
  };

  return (
    <div className={`${styles.wrapper} ${isMobile ? styles.mobile : styles.pc}`}>
      {loading && (
        <div className={styles.gLoading}>
          <Spin tip={gLoadingText} size="large">
            <div style={{ width: '280px' }}>1</div>
          </Spin>
        </div>
      )}

      {/* 云端配置错误提示 */}
      {cloudConfigError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#fff2f0', border: '1px solid #ffccc7',
          padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <span style={{ color: '#cf1322', fontSize: 14 }}>{cloudConfigError}</span>
          <Button type="primary" size="small" onClick={() => setCloudConfigVisible(true)}>
            配置云端连接
          </Button>
        </div>
      )}

      {/* 云端配置弹窗 */}
      <Modal
        title="配置云端服务连接"
        open={cloudConfigVisible}
        onOk={handleSaveCloudConfig}
        onCancel={() => setCloudConfigVisible(false)}
        confirmLoading={cloudConfigLoading}
        okText="保存并连接"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16, color: '#666', fontSize: 13 }}>
          请输入云端服务地址和管理员账号密码，用于连接云端数据库获取报告数据。
        </div>
        <Form layout="vertical">
          <Form.Item label="云端服务地址" required>
            <Input
              placeholder="例如: https://report.jlyl.net.cn 或 http://192.168.1.100:3002"
              value={cloudConfigForm.cloudUrl}
              onChange={(e) => setCloudConfigForm({ ...cloudConfigForm, cloudUrl: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="管理员用户名" required>
            <Input
              placeholder="管理员用户名"
              value={cloudConfigForm.adminUsername}
              onChange={(e) => setCloudConfigForm({ ...cloudConfigForm, adminUsername: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="管理员密码" required>
            <Input.Password
              placeholder="管理员密码"
              value={cloudConfigForm.adminPassword}
              onChange={(e) => setCloudConfigForm({ ...cloudConfigForm, adminPassword: e.target.value })}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Header */}
      {isMobile ? (
        <div className={styles.header}>
          <div className={styles.headerBanner}>{displayUsername}</div>
          <div className={styles.headerUpdate}>最后更新:{lastUpdate}</div>
        </div>
      ) : (
        <div className={styles.header}>
          <Row gutter={16} className={styles.headerContent}>
            <Col span={8}>
              <div className={styles.lastTime}>最后更新时间：{lastUpdate}</div>
            </Col>
            <Col span={8}>
              <div className={styles.headerName}>{displayUsername}</div>
            </Col>
            <Col span={8}>
              <div className={styles.currentTime}>{currentTime}</div>
            </Col>
          </Row>
        </div>
      )}

      {/* 用户切换（仅管理员可见）*/}
      {isAdmin && (
        <div className={styles.userSwitchWrapper}>
          <span className={styles.userSwitchLabel}>切换用户：</span>
          <Select
            value={selectedUserId || undefined}
            placeholder="切换"
            onChange={(val) => setSelectedUserId(val ? String(val) : '')}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: isMobile ? 140 : 100 }}
            options={users.map((u) => ({ value: String(u.id), label: u.username }))}
          />
        </div>
      )}

      {/* Content */}
      <div className={styles.contentWrapper}>
        {!isMobile ? (
          <div className={styles.pc}>
            <Row className={styles.leftWrapper} gutter={24}>
              <Col span={10} className={styles.leftCol}>
                <div className={styles.baseInfo}><AICard isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info1}><PlatformRatioChart isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info2}><KeywordRankChart isMobile={false} userId={selectedUserId} /></div>
              </Col>
              <Col span={13} className={styles.rightCol}>
                <div className={styles.info3}><KeywordStats isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info4}><SearchRank isMobile={false} userId={selectedUserId} /></div>
              </Col>
            </Row>
          </div>
        ) : (
          <div className={styles.mobile}>
            <div className={styles.baseInfo}><AICard isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info3}><KeywordStats isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info1}><PlatformRatioChart isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info2}><KeywordRankChart isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info4}><SearchRank isMobile={true} userId={selectedUserId} /></div>
          </div>
        )}
      </div>
      <div className={styles.footerWrapper} />

      {/* 底部特别声明 */}
      <div className={styles.disclaimer}>
        特别声明：由于各大模型的搜索结果因人而异，报表检测数据请以系统当前的实际检测结果为准。若出现轻微波动属于正常情况，建议可更换不同设备进行多次检索以获得更稳定的参考。
      </div>

      {/* 分享报告弹窗 */}
      <Modal
        title="分享GEO报告"
        open={shareModalVisible}
        onCancel={() => setShareModalVisible(false)}
        footer={null}
        width={isMobile ? '90%' : 560}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>自定义报告标题（可选）：</div>
            <Input
              placeholder="如：川务财税-GEO报告"
              value={shareCustomTitle}
              onChange={(e) => setShareCustomTitle(e.target.value)}
              maxLength={50}
            />
            <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
              设置后，分享链接打开后浏览器顶部及加载页面将显示此标题，留空则默认显示"聚量引力GEO"。
            </div>
          </div>
          <Button
            type="primary"
            onClick={onGenerateShare}
            loading={shareLoading}
            block
          >
            生成新的分享链接
          </Button>
          <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
            分享链接有效期为365天，打开后自动登录并显示当前{isAdmin ? '选中用户' : '用户'}的GEO报告。
          </div>
        </div>

        {shareUrl && (
          <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 4 }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>最新分享链接：</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={shareUrl}
                readOnly
                style={{
                  flex: 1, padding: '6px 8px', border: '1px solid #d9d9d9',
                  borderRadius: 4, fontSize: 12, color: '#333'
                }}
              />
              <Button type="primary" size="small" onClick={onCopyShareUrl}>
                复制
              </Button>
            </div>
          </div>
        )}

        {shareTokens.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8, borderTop: '1px solid #eee', paddingTop: 12 }}>
              历史分享链接：
            </div>
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {shareTokens.map((item) => (
                <div key={item.token} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 12
                }}>
                  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
                    {window.location.origin}/share/{item.token.substring(0, 16)}...
                  </div>
                  <div style={{ color: '#999', marginRight: 8, fontSize: 11 }}>
                    {item.lastUseTime ? `最近使用: ${new Date(item.lastUseTime).toLocaleDateString()}` : `创建: ${new Date(item.createTime).toLocaleDateString()}`}
                  </div>
                  <Button
                    size="small"
                    danger
                    onClick={() => onDeleteShareToken(item.token)}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
