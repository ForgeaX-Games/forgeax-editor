// Built-in workflow recipe registry. Recipes are data and only reference the
// capability registry; execution remains owned by the existing product seam.

import type { WorkflowRecipe } from '../contracts/workflow';

export class WorkflowRecipeRegistry {
  private readonly recipes = new Map<string, WorkflowRecipe>();

  register(recipe: WorkflowRecipe): void {
    if (this.recipes.has(recipe.id)) throw new Error(`workflow recipe already registered: ${recipe.id}`);
    this.recipes.set(recipe.id, Object.freeze({ ...recipe, steps: Object.freeze([...recipe.steps]) }));
  }

  get(id: string): WorkflowRecipe | undefined {
    return this.recipes.get(id);
  }

  list(): readonly WorkflowRecipe[] {
    return Object.freeze([...this.recipes.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }
}
