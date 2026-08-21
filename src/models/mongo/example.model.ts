import { Schema, model } from "mongoose";

export interface ExampleDocument {
  title: string;
  createdAt: Date;
}

const exampleSchema = new Schema<ExampleDocument>({
  title: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const ExampleModel = model<ExampleDocument>("Example", exampleSchema);
