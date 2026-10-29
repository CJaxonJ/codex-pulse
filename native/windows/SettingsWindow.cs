using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexPulse {
    internal sealed class SettingsWindow : Form {
        private readonly TabControl tabs;
        private readonly RichTextBox feedback;
        private readonly Label quota;
        private readonly Button save, refresh, card;
        private readonly ComboBox policy;
        private readonly NumericUpDown threshold;
        private readonly Dictionary<string, CheckBox> switches = new Dictionary<string, CheckBox>();
        private readonly string[] policies = { "strict_reserve", "finish_current", "deadline" };
        private Dictionary<string, object> baseline;
        private bool busy, autoRedeem;

        internal SettingsWindow() {
            Program.Style(this, "Codex Pulse · 设置"); ClientSize = new Size(640, 640);
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
            foreach (SizeType type in new[] { SizeType.AutoSize, SizeType.AutoSize, SizeType.AutoSize, SizeType.Percent, SizeType.Absolute, SizeType.AutoSize }) layout.RowStyles.Add(new RowStyle(type, type == SizeType.Percent ? 100 : type == SizeType.Absolute ? 48 : 0));
            layout.Controls.Add(new Label { Text = "Codex Pulse", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 12) }, 0, 0);
            quota = new Label { AutoSize = true, Text = "正在读取本机额度记录…", MaximumSize = new Size(560, 0), Margin = new Padding(0, 0, 0, 12) };
            layout.Controls.Add(quota, 0, 1);
            FlowLayoutPanel navigation = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 0, 0, 12) };
            navigation.Controls.Add(Program.Button("消息历史", delegate { using (HistoryWindow view = new HistoryWindow(false)) view.ShowDialog(this); }));
            navigation.Controls.Add(Program.Button("续跑计划", delegate { using (HistoryWindow view = new HistoryWindow(true)) view.ShowDialog(this); }));
            layout.Controls.Add(navigation, 0, 2);
            tabs = new TabControl { Dock = DockStyle.Fill, Margin = new Padding(0) };
            TabPage reminders = new TabPage("提醒设置") { Padding = new Padding(16) };
            FlowLayoutPanel choices = Vertical();
            FlowLayoutPanel policyRow = Row();
            policyRow.Controls.Add(Caption("额度保护方式"));
            policy = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 280, AccessibleName = "额度保护方式" };
            policy.Items.AddRange(new object[] { "10% 暂停并保存进度（默认）", "先完成当前有限结果，再暂停", "优先完成有截止时间的任务" });
            policyRow.Controls.Add(policy); choices.Controls.Add(policyRow);
            AddSwitch(choices, "quotaAlertsEnabled", "提前额度提醒");
            FlowLayoutPanel thresholdRow = Row(); thresholdRow.Controls.Add(Caption("提前提醒比例"));
            threshold = new NumericUpDown { Minimum = 15, Maximum = 80, Value = 20, Width = 80, AccessibleName = "提前提醒比例" };
            thresholdRow.Controls.Add(threshold); thresholdRow.Controls.Add(Caption("%（不改变 10% 保护线）")); choices.Controls.Add(thresholdRow);
            AddSwitch(choices, "tiboEnabled", "Tibo 重置消息");
            AddSwitch(choices, "creditAlertsEnabled", "重置卡临期提醒");
            AddSwitch(choices, "persistentAlertsEnabled", "重要提醒保留到我关闭");
            AddSwitch(choices, "soundEnabled", "声音提醒");
            reminders.Controls.Add(choices);
            TabPage protection = new TabPage("保护与用卡") { Padding = new Padding(16) };
            FlowLayoutPanel protections = Vertical();
            protections.Controls.Add(new Label { Text = "保护授权与自动用卡分别确认，互不代替。", AutoSize = true, Margin = new Padding(0, 0, 0, 16) });
            protections.Controls.Add(Program.Button("审查保护授权", delegate { using (ProtectionWindow view = new ProtectionWindow()) view.ShowDialog(this); }));
            protections.Controls.Add(new Label { Text = "仅在你本人确认具体定义后启用。\n不会替你批准其他命令，也不会重启正在运行的 Codex。", AutoSize = true, MaximumSize = new Size(520, 0), Margin = new Padding(0, 12, 0, 24) });
            card = Program.Button("正在读取用卡设置…", async delegate { await ChangeCardPolicy(); }); card.Enabled = false;
            protections.Controls.Add(card);
            protections.Controls.Add(new Label { Text = "默认关闭。开启后，仅对已授权个人账号生效：\n卡距过期不足 10 分钟、确有额度可重置时使用最早过期的一张。\n不会购买；睡眠、离线可能错过到期。", AutoSize = true, MaximumSize = new Size(520, 0), Margin = new Padding(0, 12, 0, 0) });
            protection.Controls.Add(protections); tabs.TabPages.Add(reminders); tabs.TabPages.Add(protection);
            layout.Controls.Add(tabs, 0, 3);
            feedback = Program.TextArea(); feedback.Margin = new Padding(0, 8, 0, 8); feedback.Text = "修改提醒偏好后，点击保存修改。";
            layout.Controls.Add(feedback, 0, 4);
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0) };
            save = Program.Button("保存修改", async delegate { await SaveSettings(); }); save.BackColor = Program.Green; save.ForeColor = Color.White; save.Enabled = false;
            refresh = Program.Button("刷新", async delegate { await LoadSnapshot(); });
            Button close = Program.Button("关闭", delegate { Close(); }); actions.Controls.Add(save); actions.Controls.Add(refresh); actions.Controls.Add(close);
            layout.Controls.Add(actions, 0, 5); Controls.Add(layout); CancelButton = close;
            Shown += async delegate { await LoadSnapshot(); };
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) args.Cancel = true; };
        }
        private static FlowLayoutPanel Vertical() { return new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true }; }
        private static FlowLayoutPanel Row() { return new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 12) }; }
        private static Label Caption(string title) { return new Label { Text = title, AutoSize = true, Margin = new Padding(0, 4, 12, 0) }; }
        private void AddSwitch(Control parent, string key, string title) {
            CheckBox control = new CheckBox { Text = title, AutoSize = true, AccessibleName = title, AccessibleRole = AccessibleRole.CheckButton, Margin = new Padding(0, 0, 0, 12) };
            switches.Add(key, control); parent.Controls.Add(control);
        }
        private void Apply(Dictionary<string, object> result) {
            object raw;
            Dictionary<string, object> settings = result.TryGetValue("settings", out raw) ? raw as Dictionary<string, object> : null;
            if (!Program.BooleanValue(result, "ok", false) || settings == null) throw new InvalidOperationException();
            int index = Array.IndexOf(policies, Program.StringValue(settings, "quotaPolicy"));
            if (index < 0) throw new InvalidOperationException();
            int percent = Convert.ToInt32(settings["lowQuotaPercent"]);
            if (percent < 15 || percent > 80) throw new InvalidOperationException();
            policy.SelectedIndex = index; threshold.Value = percent;
            foreach (KeyValuePair<string, CheckBox> entry in switches) entry.Value.Checked = Program.BooleanValue(settings, entry.Key, true);
            baseline = new Dictionary<string, object>(settings);
            autoRedeem = Program.BooleanValue(result, "autoRedeemEnabled", false);
            card.Text = autoRedeem ? "关闭临期自动用卡" : "开启临期自动用卡";
            card.Enabled = true; save.Enabled = true;
        }
        private async Task LoadSnapshot() {
            if (busy) return;
            refresh.Enabled = false; save.Enabled = false; card.Enabled = false; tabs.Enabled = false;
            try {
                Dictionary<string, object> result = await Bridge.Run("settings");
                if (IsDisposed) return; Apply(result);
                feedback.Text = "偏好只存本机。修改提醒偏好后，点击保存修改。";
            } catch { if (!IsDisposed) feedback.Text = "尚未读到设置，请检查安装后刷新。没有自动修改偏好或授权。"; }
            finally { if (!IsDisposed) { tabs.Enabled = true; refresh.Enabled = true; } }
            if (IsDisposed) return;
            try {
                Dictionary<string, object> activity = await Bridge.Run("activity");
                if (IsDisposed) return;
                object raw; Dictionary<string, object> data = activity.TryGetValue("quota", out raw) ? raw as Dictionary<string, object> : null;
                if (data == null) throw new InvalidOperationException();
                string freshness = "未读到近期额度，以下可能是旧记录。";
                object checkedAt;
                if (data.TryGetValue("checkedAt", out checkedAt) && checkedAt != null) {
                    double age = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - Convert.ToDouble(checkedAt);
                    if (age >= -30 && age <= 180) freshness = "最近一次后台记录";
                }
                quota.Text = freshness + "\n5 小时剩余 " + Percent(data, "fiveHour") + "     本周剩余 " + Percent(data, "weekly") + "\n检查时间：" + Program.LocalTime(data, "checkedAt");
            } catch { if (!IsDisposed) quota.Text = "暂时无法读取本机额度记录。请检查后台是否正常运行。"; }
        }
        private static string Percent(Dictionary<string, object> data, string key) {
            object raw, remaining;
            Dictionary<string, object> window = data.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
            if (window == null || !window.TryGetValue("remainingPercent", out remaining) || remaining == null) return "未知";
            double percent = Convert.ToDouble(remaining);
            return Double.IsNaN(percent) || Double.IsInfinity(percent) || percent < 0 || percent > 100 ? "未知" : percent.ToString("0.#") + "%";
        }
        private Dictionary<string, object> Patch() {
            Dictionary<string, object> values = switches.ToDictionary(entry => entry.Key, entry => (object)entry.Value.Checked);
            values["quotaPolicy"] = policies[policy.SelectedIndex]; values["lowQuotaPercent"] = (int)threshold.Value;
            return values.Where(entry => !baseline.ContainsKey(entry.Key) || !Object.Equals(baseline[entry.Key], entry.Value)).ToDictionary(entry => entry.Key, entry => entry.Value);
        }
        private void SetBusy(bool value) { busy = value; tabs.Enabled = !value; save.Enabled = !value && baseline != null; refresh.Enabled = !value; }
        private async Task SaveSettings() {
            if (busy || baseline == null || policy.SelectedIndex < 0) return;
            Dictionary<string, object> patch = Patch();
            if (patch.Count == 0) { feedback.Text = "没有待保存的修改。"; return; }
            SetBusy(true); feedback.Text = "正在保存提醒偏好…";
            try {
                Dictionary<string, object> result = await Bridge.Run("settings", "--update", Program.Json.Serialize(patch));
                if (IsDisposed) return; Apply(result); feedback.Text = "已保存。后台会读取新偏好，无需重启。";
            } catch { if (!IsDisposed) feedback.Text = "未能确认保存，请刷新核对。不会自动重复提交修改。"; }
            finally { if (!IsDisposed) SetBusy(false); }
        }
        private async Task ChangeCardPolicy() {
            if (busy || baseline == null) return;
            bool enabling = !autoRedeem;
            if (enabling) using (CreditConsentWindow consent = new CreditConsentWindow()) { if (consent.ShowDialog(this) != DialogResult.OK) { feedback.Text = "用卡设置未更改。"; return; } }
            SetBusy(true); feedback.Text = enabling ? "正在绑定当前个人账号的用卡授权…" : "正在关闭临期自动用卡…";
            try {
                Dictionary<string, object> result = enabling ? await Bridge.Run("credits-policy", "--enable", "--yes") : await Bridge.Run("credits-policy", "--disable");
                if (IsDisposed) return;
                if (!Program.BooleanValue(result, "ok", false) || Program.BooleanValue(result, "enabled", false) != enabling) throw new InvalidOperationException();
                // Do not re-apply all controls and discard unsaved reminder edits.
                autoRedeem = enabling; card.Text = autoRedeem ? "关闭临期自动用卡" : "开启临期自动用卡";
                feedback.Text = enabling ? "临期自动用卡已开启，仅对这次授权的个人账号生效。" : "临期自动用卡已关闭。";
            } catch { if (!IsDisposed) { card.Enabled = false; feedback.Text = "尚未确认用卡设置，请刷新核对。不会自动重复提交授权。"; } }
            finally { if (!IsDisposed) SetBusy(false); }
        }
    }

    internal sealed class CreditConsentWindow : Form {
        internal CreditConsentWindow() {
            Program.Style(this, "Codex Pulse · 自动用卡授权");
            RichTextBox text = Program.TextArea();
            text.Text = "是否为当前 Codex 登录的个人订阅账号开启？\n\n仅在重置卡距过期不足 10 分钟，且当前确有额度可重置时，使用最早过期的一张。\n\n使用后重新读取额度，不会连续浪费多张卡，也不会购买重置卡。\n\n只对这次授权的个人账号生效；切换到其他账号不会沿用授权。\n\n睡眠或离线可能错过到期，不能保证一定用上。\n\n此授权独立于 Hook 保护授权。";
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 16, 0, 0) };
            Button yes = Program.Button("确认开启自动用卡", delegate { DialogResult = DialogResult.OK; Close(); });
            Button no = Program.Button("暂不开启", delegate { DialogResult = DialogResult.Cancel; Close(); });
            actions.Controls.Add(yes); actions.Controls.Add(no); Controls.Add(text); Controls.Add(actions); CancelButton = no;
            // Enter is deliberately not a consent shortcut.
        }
    }
}
