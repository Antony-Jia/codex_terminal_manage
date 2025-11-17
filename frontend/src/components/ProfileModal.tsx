import { Form, Input, Modal, Space } from "antd";
import { useState } from "react";

export interface ProfileFormValues {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

interface ProfileModalProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (values: ProfileFormValues) => Promise<void>;
}

const buildEnvObject = (lines: string): Record<string, string> => {
  const env: Record<string, string> = {};
  lines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [key, ...rest] = line.split("=");
      if (key) {
        env[key.trim()] = rest.join("=").trim();
      }
    });
  return env;
};

const ProfileModal = ({ open, onCancel, onSubmit }: ProfileModalProps) => {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const args = values.args
        ? (values.args as string)
            .split(/\s+/)
            .map((item: string) => item.trim())
            .filter(Boolean)
        : [];
      const env = values.env ? buildEnvObject(values.env as string) : {};
      await onSubmit({
        name: values.name,
        command: values.command,
        args,
        cwd: values.cwd || undefined,
        env,
      });
      form.resetFields();
      onCancel();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建启动配置"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form layout="vertical" form={form}>
        <Form.Item
          name="name"
          label="配置名称"
          rules={[{ required: true, message: "请输入配置名称" }]}
        >
          <Input placeholder="例如：默认 PowerShell" allowClear />
        </Form.Item>
        <Form.Item
          name="command"
          label="启动命令"
          rules={[{ required: true, message: "请输入命令" }]}
          initialValue="pwsh"
        >
          <Input placeholder="pwsh / bash / python" allowClear />
        </Form.Item>
        <Space size="middle" style={{ width: "100%" }}>
          <Form.Item name="args" label="命令参数" style={{ flex: 1 }}>
            <Input placeholder="以空格分隔，例如：-NoLogo -NoProfile" allowClear />
          </Form.Item>
          <Form.Item name="cwd" label="工作目录" style={{ flex: 1 }}>
            <Input placeholder="可选，默认为项目根目录" allowClear />
          </Form.Item>
        </Space>
        <Form.Item name="env" label="附加环境变量">
          <Input.TextArea
            rows={4}
            placeholder="使用 KEY=VALUE 的格式，每行一条"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ProfileModal;
