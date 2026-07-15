import { App, Modal, Setting } from "obsidian";

export function confirmModal(app: App, title: string, body: string, acceptText = "允许", declineText = "拒绝"): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, title, body, acceptText, declineText, resolve);
    modal.open();
  });
}

export function textInputModal(app: App, title: string, label: string, initialValue = "", options: { secret?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new TextInputModal(app, title, label, initialValue, options.secret === true, resolve);
    modal.open();
  });
}

export function requestUserInputModal(app: App, questions: any[]): Promise<Record<string, { answers: string[] }>> {
  return new Promise((resolve) => {
    const modal = new RequestInputModal(app, questions, resolve);
    modal.open();
  });
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly bodyText: string,
    private readonly acceptText: string,
    private readonly declineText: string,
    private readonly done: (accepted: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    contentEl.createEl("p", { text: this.bodyText });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(this.declineText).onClick(() => {
          this.done(false);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(this.acceptText)
          .setCta()
          .onClick(() => {
            this.done(true);
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TextInputModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly label: string,
    initialValue: string,
    private readonly secret: boolean,
    private readonly done: (value: string | null) => void
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    new Setting(contentEl).setName(this.label).addText((text) => {
      if (this.secret) text.inputEl.type = "password";
      text.setValue(this.value).onChange((value) => {
        this.value = value;
      });
      text.inputEl.focus();
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.done(null);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("保存")
          .setCta()
          .onClick(() => {
            this.done(this.value.trim());
            this.close();
          })
      );
  }
}

class RequestInputModal extends Modal {
  private answers: Record<string, string[]> = {};

  constructor(app: App, private readonly questions: any[], private readonly done: (answers: Record<string, { answers: string[] }>) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Codex 需要你的选择" });
    for (const question of this.questions) {
      const options = Array.isArray(question.options) ? question.options : [];
      const setting = new Setting(contentEl).setName(question.header || question.question).setDesc(question.question || "");
      if (options.length > 0) {
        this.answers[question.id] = [options[0].label];
        setting.addDropdown((dropdown) => {
          for (const option of options) dropdown.addOption(option.label, option.label);
          dropdown.onChange((value) => {
            this.answers[question.id] = [value];
          });
        });
      } else {
        this.answers[question.id] = [""];
        setting.addText((text) => {
          if (question.isSecret) text.inputEl.type = "password";
          text.onChange((value) => {
            this.answers[question.id] = [value];
          });
        });
      }
    }
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.done({});
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("提交")
          .setCta()
          .onClick(() => {
            const result = Object.fromEntries(Object.entries(this.answers).map(([key, value]) => [key, { answers: value }]));
            this.done(result);
            this.close();
          })
      );
  }
}
