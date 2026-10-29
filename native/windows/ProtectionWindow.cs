using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexPulse {
    internal sealed class ProtectionWindow : Form {
        private readonly RichTextBox explanation;
        private readonly Button confirm, later, disclosure;
        private string reviewId;
        private string definitions = "尚未读到权限详情。";
        private bool busy, trusted;
        internal ProtectionWindow() {
            Program.Style(this, "Codex Pulse · 保护授权");
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { Text = "开启自动保护", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 16) }, 0, 0);
            explanation = Program.TextArea();
            explanation.Text = "低额度时暂停，留下当前进度。\n\n恢复后核对原目标、任务与文件，再继续。\n\n进度只存本机，不发送给开发者。\n\n不会替你批准其他权限或使用重置卡。\n\n正在核对本机保护组件…";
            layout.Controls.Add(explanation, 0, 1);
            disclosure = Program.Button("查看权限详情", delegate {
                using (Form detail = new Form()) {
                    Program.Style(detail, "Codex Pulse · 权限详情");
                    RichTextBox text = Program.TextArea(); text.Text = definitions;
                    FlowLayoutPanel close = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
                    close.Controls.Add(Program.Button("返回", delegate { detail.Close(); }));
                    detail.Controls.Add(text); detail.Controls.Add(close); detail.ShowDialog(this);
                }
            });
            disclosure.Enabled = false; disclosure.Margin = new Padding(0, 16, 0, 16);
            layout.Controls.Add(disclosure, 0, 2);
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0) };
            confirm = Program.Button("开启自动保护", async delegate { if (trusted) Close(); else if (reviewId == null) await Prepare(); else await Enable(); });
            confirm.BackColor = Program.Green; confirm.ForeColor = Color.White; confirm.Enabled = false;
            later = Program.Button("稍后开启", delegate { Close(); });
            actions.Controls.Add(confirm); actions.Controls.Add(later);
            layout.Controls.Add(actions, 0, 3); Controls.Add(layout); CancelButton = later;
            Shown += async delegate { await Prepare(); };
            // Reading can be abandoned safely. An in-flight write is not
            // labelled cancelled while Codex may still be committing it.
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) args.Cancel = true; };
        }
        private async Task Prepare() {
            reviewId = null; confirm.Enabled = false; disclosure.Enabled = false;
            try {
                Dictionary<string, object> result = await Bridge.Run("protection", "prepare");
                if (IsDisposed) return;
                if (!Program.BooleanValue(result, "ok", false)) throw new InvalidOperationException();
                StringBuilder text = new StringBuilder("仅授权本机这一份 Codex Pulse 定义；定义变化后需要重新审查。\n\n");
                object raw;
                IEnumerable values = result.TryGetValue("details", out raw) ? raw as IEnumerable : null;
                if (values == null) throw new InvalidOperationException();
                foreach (Dictionary<string, object> item in values.Cast<object>().OfType<Dictionary<string, object>>()) {
                    foreach (string key in new[] { "purpose", "command", "source", "hash" }) text.AppendLine(Program.StringValue(item, key));
                    text.AppendLine();
                }
                definitions = text.ToString(); disclosure.Enabled = true;
                trusted = Program.BooleanValue(result, "trusted", false);
                if (trusted) ShowConfirmed();
                else {
                    string id = Program.StringValue(result, "reviewId");
                    Guid parsed;
                    if (!Guid.TryParse(id, out parsed)) throw new InvalidOperationException();
                    reviewId = id; confirm.Text = "开启自动保护";
                    explanation.Text = "低额度时暂停，留下当前进度。\n\n恢复后核对原目标、任务与文件，再继续。\n\n进度只存本机，不发送给开发者。\n\n不会替你批准其他权限或使用重置卡。\n\n已核对本机保护组件。你可以查看具体定义，再决定是否开启。\n\n授权对新会话生效，不会打断当前任务。";
                }
            } catch { if (!IsDisposed) { reviewId = null; confirm.Text = "重新核对"; explanation.Text = "暂时无法核对本机保护组件。\n\n未确认授权，提醒功能仍可使用。请检查安装与 Codex 登录状态后重新核对。"; } }
            finally { if (!IsDisposed) confirm.Enabled = true; }
        }
        private async Task Enable() {
            if (busy || reviewId == null) return;
            busy = true; confirm.Enabled = false; later.Enabled = false; disclosure.Enabled = false;
            explanation.Text = "正在确认你审查过的这份定义…\n\n不会自动重启 Codex 或打断正在运行的任务。";
            try {
                Dictionary<string, object> result = await Bridge.Run("protection", "enable", "--review", reviewId, "--yes");
                if (IsDisposed) return;
                if (!Program.BooleanValue(result, "ok", false) || !Program.BooleanValue(result, "trusted", false)) throw new InvalidOperationException();
                ShowConfirmed();
            } catch {
                if (!IsDisposed) {
                    reviewId = null; trusted = false; confirm.Text = "重新核对";
                    explanation.Text = "尚未确认授权生效。\n\n定义可能发生变化，或本机连接暂时不可用。请重新核对；不会自动重复提交这次确认。\n\n提醒功能仍可使用。";
                }
            } finally {
                busy = false;
                if (!IsDisposed) { confirm.Enabled = true; later.Enabled = true; disclosure.Enabled = true; }
            }
        }
        private void ShowConfirmed() {
            trusted = true; reviewId = null; confirm.Text = "完成"; later.Text = "关闭";
            explanation.Text = "保护授权已确认。\n\n新会话会加载这份授权。已打开的会话请在方便时重新打开 Codex。\n\n现在不会自动重启 Codex，也不会中断正在运行的任务。\n\n这不包含自动使用重置卡的授权。";
        }
    }
}
