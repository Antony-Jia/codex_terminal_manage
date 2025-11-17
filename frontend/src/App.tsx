import {
  BranchesOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Descriptions,
  Empty,
  Layout,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import type { SelectProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import ProfileModal, { ProfileFormValues } from "./components/ProfileModal";
import TerminalPanel, { TerminalStatus } from "./components/TerminalPanel";
import { GitChanges, Profile, SessionResponse, api } from "./api";

const { Header, Content, Sider } = Layout;
const { Paragraph, Text } = Typography;

const statusColors: Record<TerminalStatus, { color: string; label: string }> = {
  idle: { color: "default", label: "未连接" },
  connecting: { color: "geekblue", label: "连接中" },
  connected: { color: "green", label: "已连接" },
  closed: { color: "default", label: "已关闭" },
  error: { color: "red", label: "异常" },
};

const App = () => {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<number>();
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>("idle");
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logContent, setLogContent] = useState("尚未产生日志");
  const [gitInfo, setGitInfo] = useState<GitChanges | null>(null);
  const [gitLoading, setGitLoading] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      setProfilesLoading(true);
      const data = await api.fetchProfiles();
      const list = Array.isArray(data) ? data : [];
      setProfiles(list);
      if (!selectedProfileId && list.length) {
        setSelectedProfileId(list[0].id);
      }
    } catch (error) {
      message.error("加载配置失败，请检查后端服务");
    } finally {
      setProfilesLoading(false);
    }
  };

  const handleProfileSubmit = async (values: ProfileFormValues) => {
    try {
      const created = await api.createProfile(values);
      message.success("配置创建成功");
      setProfiles((prev) => (Array.isArray(prev) ? [...prev, created] : [created]));
      setSelectedProfileId(created.id);
    } catch (error) {
      message.error("创建配置失败");
      throw error;
    }
  };

  const handleDeleteProfile = async (id: number) => {
    try {
      await api.deleteProfile(id);
      message.success("配置已删除");
      setProfiles((prev) => (Array.isArray(prev) ? prev.filter((item) => item.id !== id) : []));
      if (selectedProfileId === id) {
        setSelectedProfileId(undefined);
      }
    } catch (error) {
      message.error("删除失败");
    }
  };

  const handleCreateSession = async () => {
    if (!selectedProfileId) {
      message.warning("请先选择一个配置");
      return;
    }
    try {
      setCreatingSession(true);
      const info = await api.createSession(selectedProfileId);
      setSession(info);
      setGitInfo(null);
      message.success(`会话 ${info.session_id} 已创建`);
    } catch (error) {
      message.error("创建会话失败");
    } finally {
      setCreatingSession(false);
    }
  };

  const openLogModal = async () => {
    if (!session) {
      message.info("请先创建会话");
      return;
    }
    setLogModalOpen(true);
    setLogLoading(true);
    try {
      const log = await api.fetchLogs(session.session_id);
      setLogContent(log.content || "暂无日志");
    } catch (error) {
      setLogContent("日志加载失败");
    } finally {
      setLogLoading(false);
    }
  };

  const fetchGitInfo = async () => {
    if (!session) {
      message.info("请先创建会话");
      return;
    }
    try {
      setGitLoading(true);
      const result = await api.fetchGitChanges(session.session_id);
      setGitInfo(result);
      if (!result.git) {
        message.info(result.message || "当前目录不是 Git 仓库");
      }
    } catch (error) {
      message.error("获取 Git 状态失败");
    } finally {
      setGitLoading(false);
    }
  };

  const safeProfiles = Array.isArray(profiles) ? profiles : [];

  const profileOptions = useMemo<SelectProps["options"]>(() => {
    return safeProfiles.map((profile) => ({ label: profile.name, value: profile.id }));
  }, [safeProfiles]);

  const currentProfile = useMemo(
    () => safeProfiles.find((item) => item.id === selectedProfileId),
    [safeProfiles, selectedProfileId],
  );

  const gitStatusBlock = () => {
    if (!gitInfo) {
      return <Empty description="暂无 Git 信息" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
    }
    if (!gitInfo.git) {
      return <Empty description={gitInfo.message || "未进入 Git 仓库"} />;
    }
    return (
      <>
        <List
          size="small"
          dataSource={gitInfo.status || []}
          header={<Text strong>git status --short</Text>}
          locale={{ emptyText: "工作树干净" }}
          renderItem={(item) => (
            <List.Item>
              <Space>
                <Tag color="blue">{item.status}</Tag>
                <Text>{item.path}</Text>
              </Space>
            </List.Item>
          )}
        />
        {gitInfo.diff_stat && (
          <Paragraph copyable style={{ whiteSpace: "pre-wrap" }}>
            {gitInfo.diff_stat}
          </Paragraph>
        )}
      </>
    );
  };

  return (
    <Layout>
      <Header
        style={{
          background: "#0f172a",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
        }}
      >
        <Space size="large" align="center">
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: 600 }}>Codex Web Terminal</Text>
          <Tag color={statusColors[terminalStatus].color}>{statusColors[terminalStatus].label}</Tag>
        </Space>
        <Button type="primary" icon={<ReloadOutlined />} ghost onClick={() => void loadProfiles()}>
          刷新配置
        </Button>
      </Header>
      <Layout>
        <Sider width={360} style={{ background: "#f7f9fc", padding: 16 }}>
          <Card
            title="会话配置"
            extra={
              <Button type="link" icon={<PlusCircleOutlined />} onClick={() => setProfileModalOpen(true)}>
                新建
              </Button>
            }
            bordered={false}
          >
            <Space direction="vertical" style={{ width: "100%" }} size="large">
              <div>
                <Text type="secondary">选择启动配置</Text>
                <Select
                  style={{ width: "100%", marginTop: 8 }}
                  placeholder="请选择配置"
                  options={profileOptions}
                  loading={profilesLoading}
                  value={selectedProfileId}
                  onChange={(value) => setSelectedProfileId(value)}
                  allowClear
                />
              </div>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                block
                loading={creatingSession}
                onClick={() => void handleCreateSession()}
              >
                启动会话
              </Button>
              <Spin spinning={profilesLoading}>
                <List
                  className="profile-list"
                  size="small"
                  dataSource={profiles}
                  locale={{ emptyText: "暂无配置，请先创建" }}
                  renderItem={(item) => (
                    <List.Item
                      actions={[
                        <Popconfirm
                          title="确认删除?"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={() => void handleDeleteProfile(item.id)}
                        >
                          <Button type="text" icon={<DeleteOutlined />} danger />
                        </Popconfirm>,
                      ]}
                    >
                      <List.Item.Meta
                        title={
                          <Space>
                            <Text strong>{item.name}</Text>
                            {selectedProfileId === item.id && <Tag color="blue">当前</Tag>}
                          </Space>
                        }
                        description={
                          <div>
                            <Text type="secondary">{item.command} {item.args.join(" ")}</Text>
                            <br />
                            <Text type="secondary">{item.cwd || "默认目录"}</Text>
                          </div>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Spin>
            </Space>
          </Card>
        </Sider>
        <Content style={{ padding: 24 }}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card
              title="交互终端"
              extra={
                <Space>
                  <Button icon={<BranchesOutlined />} loading={gitLoading} onClick={() => void fetchGitInfo()}>
                    查看 Git 改动
                  </Button>
                  <Button icon={<FileTextOutlined />} onClick={() => void openLogModal()}>
                    查看日志
                  </Button>
                </Space>
              }
            >
              <TerminalPanel sessionId={session?.session_id} onStatusChange={setTerminalStatus} />
            </Card>
            <Card title="当前会话信息">
              {session && currentProfile ? (
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="Profile">{currentProfile.name}</Descriptions.Item>
                  <Descriptions.Item label="Command">
                    {currentProfile.command} {currentProfile.args.join(" ")}
                  </Descriptions.Item>
                  <Descriptions.Item label="工作目录">{currentProfile.cwd || "默认目录"}</Descriptions.Item>
                  <Descriptions.Item label="Session ID">{session.session_id}</Descriptions.Item>
                </Descriptions>
              ) : (
                <Empty description="暂未创建会话" />
              )}
            </Card>
            <Card title="Git 状态">{gitStatusBlock()}</Card>
          </Space>
        </Content>
      </Layout>
      <ProfileModal
        open={profileModalOpen}
        onCancel={() => setProfileModalOpen(false)}
        onSubmit={handleProfileSubmit}
      />
      <Modal
        title="Session 日志"
        open={logModalOpen}
        onCancel={() => setLogModalOpen(false)}
        footer={null}
        width={720}
        bodyStyle={{ maxHeight: 500, overflowY: "auto" }}
      >
        <Spin spinning={logLoading}>
          <Paragraph style={{ whiteSpace: "pre-wrap", fontFamily: "Cascadia Code, monospace" }}>
            {logContent || "暂无日志"}
          </Paragraph>
        </Spin>
      </Modal>
    </Layout>
  );
};

export default App;
